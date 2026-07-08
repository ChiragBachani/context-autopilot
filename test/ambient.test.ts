import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureVerdict,
  DEFAULT_CONFIG,
  loadConfig,
  pauseFor,
  saveConfig,
  setEnabled,
  type AmbientConfig,
} from '../dist/ambient/config.js';
import {
  isNearDuplicate,
  matchAopTrigger,
  shouldPromptAop,
  TriggerEngine,
} from '../dist/ambient/observer.js';
import {
  appendRecord,
  daysPastRetention,
  estimateObservedMinutes,
  listDays,
  readDay,
  type ActivityRecord,
} from '../dist/ambient/records.js';
import { saveAmbientState, type StoredAop } from '../dist/ambient/workflows.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-test-'));
});

function config(overrides: Partial<AmbientConfig> = {}): AmbientConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Capture gate

test('capture is blocked when the master switch is off', () => {
  const verdict = captureVerdict(config({ enabled: false }), 'Safari', 'Docs');
  assert.deepEqual(verdict, { allowed: false, reason: 'disabled' });
});

test('capture is blocked while paused, and resumes after', () => {
  const paused = config({ pausedUntil: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(captureVerdict(paused, 'Safari', 'Docs').allowed, false);
  const later = new Date(Date.now() + 120_000);
  assert.equal(captureVerdict(paused, 'Safari', 'Docs', later).allowed, true);
});

test('video-call apps and sensitive titles are blocklisted by default', () => {
  assert.deepEqual(captureVerdict(config(), 'zoom.us', 'Weekly standup'), {
    allowed: false,
    reason: 'blocklisted-app',
  });
  assert.deepEqual(captureVerdict(config(), 'Safari', 'Chase Bank — sign in'), {
    allowed: false,
    reason: 'blocklisted-title',
  });
  assert.equal(captureVerdict(config(), 'Safari', 'MDN Web Docs').allowed, true);
});

test('the off switch persists through config round-trips', () => {
  setEnabled(false);
  assert.equal(loadConfig().enabled, false);
  setEnabled(true);
  assert.equal(loadConfig().enabled, true);
  pauseFor(30);
  assert.ok(loadConfig().pausedUntil);
  setEnabled(true); // turning on clears any pause
  assert.equal(loadConfig().pausedUntil, undefined);
});

// ---------------------------------------------------------------------------
// Trigger engine — intentional moments only

const T0 = 1_800_000_000_000;

test('a burst of activity followed by idle triggers a capture', () => {
  const engine = new TriggerEngine();
  let decisions: ReturnType<TriggerEngine['tick']> = [];
  // 4 active ticks (8s of work), then the user stops.
  for (let i = 0; i < 4; i++) {
    decisions = engine.tick({ now: T0 + i * 2000, app: 'VS Code', title: 'main.ts', idleSeconds: 0.4 });
    assert.equal(decisions.length, 0);
  }
  decisions = engine.tick({ now: T0 + 8000, app: 'VS Code', title: 'main.ts', idleSeconds: 6 });
  assert.deepEqual(decisions, [{ kind: 'burst-end' }]);
  // Staying idle does not re-fire.
  decisions = engine.tick({ now: T0 + 10_000, app: 'VS Code', title: 'main.ts', idleSeconds: 8 });
  assert.equal(decisions.length, 0);
});

test('brief taps without a real burst never trigger', () => {
  const engine = new TriggerEngine();
  engine.tick({ now: T0, app: 'Mail', title: 'Inbox', idleSeconds: 0.5 });
  engine.tick({ now: T0 + 2000, app: 'Mail', title: 'Inbox', idleSeconds: 1 });
  const decisions = engine.tick({ now: T0 + 4000, app: 'Mail', title: 'Inbox', idleSeconds: 7 });
  assert.equal(decisions.length, 0);
});

test('switching context after real work captures; quick flips do not', () => {
  const engine = new TriggerEngine();
  engine.tick({ now: T0, app: 'Figma', title: 'Design', idleSeconds: 1 });
  // 30 seconds in Figma, then switch.
  engine.tick({ now: T0 + 30_000, app: 'Figma', title: 'Design', idleSeconds: 1 });
  const decisions = engine.tick({ now: T0 + 32_000, app: 'Slack', title: '#general', idleSeconds: 1 });
  assert.deepEqual(decisions, [{ kind: 'context-switch', fromApp: 'Figma' }]);
  // 4 seconds in Slack, flip again — too brief to matter.
  const flip = engine.tick({ now: T0 + 36_000, app: 'Notes', title: 'Todo', idleSeconds: 1 });
  assert.equal(flip.length, 0);
});

test('dwelling in one window fires once, then throttles', () => {
  const engine = new TriggerEngine();
  let fired = 0;
  for (let t = 0; t <= 50_000; t += 2000) {
    const decisions = engine.tick({ now: T0 + t, app: 'Sheets', title: 'Q3 Tracker', idleSeconds: 0.5 });
    fired += decisions.filter((d) => d.kind === 'dwell').length;
  }
  assert.equal(fired, 1);
  // Leave and come right back — the per-window throttle holds.
  engine.tick({ now: T0 + 52_000, app: 'Slack', title: '#general', idleSeconds: 1 });
  for (let t = 54_000; t <= 104_000; t += 2000) {
    const decisions = engine.tick({ now: T0 + t, app: 'Sheets', title: 'Q3 Tracker', idleSeconds: 0.5 });
    fired += decisions.filter((d) => d.kind === 'dwell').length;
  }
  assert.equal(fired, 1);
});

// ---------------------------------------------------------------------------
// Near-duplicate suppression

test('near-identical OCR text is a duplicate; different text is not', () => {
  const a = 'Inbox weekly metrics export ready attachment weekly-metrics.csv download';
  assert.equal(isNearDuplicate(a, a), true);
  assert.equal(isNearDuplicate(a, 'Compose weekly summary to sarah signups revenue churn'), false);
  assert.equal(isNearDuplicate(undefined, a), false);
});

// ---------------------------------------------------------------------------
// Live AOP trigger matching

function aop(overrides: Partial<StoredAop> = {}): StoredAop {
  return {
    format: 'aop/v1',
    slug: 'weekly-metrics-report',
    title: 'Weekly metrics report',
    rule: '',
    rationale: '',
    confidence: 'high',
    procedure: ['do the thing'],
    trigger: { app: 'Google Chrome', titlePattern: 'Gmail' },
    evidence: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'screen',
    ...overrides,
  };
}

test('AOP triggers match app + title fragment, case-insensitively', () => {
  const aops = [aop()];
  assert.ok(matchAopTrigger(aops, 'Google Chrome', 'Inbox (3) - Gmail'));
  assert.equal(matchAopTrigger(aops, 'Google Chrome', 'GitHub'), undefined);
  assert.equal(matchAopTrigger(aops, 'Safari', 'Gmail'), undefined);
  assert.equal(matchAopTrigger([aop({ enabled: false })], 'Google Chrome', 'Gmail'), undefined);
});

test('"don\'t ask again" and the throttle silence prompts', () => {
  assert.equal(shouldPromptAop('weekly-metrics-report'), true);
  saveAmbientState({
    version: 1,
    rejectedTitles: [],
    dontAskSlugs: ['weekly-metrics-report'],
    lastPrompted: {},
  });
  assert.equal(shouldPromptAop('weekly-metrics-report'), false);
  saveAmbientState({
    version: 1,
    rejectedTitles: [],
    dontAskSlugs: [],
    lastPrompted: { 'weekly-metrics-report': new Date().toISOString() },
  });
  assert.equal(shouldPromptAop('weekly-metrics-report'), false);
});

// ---------------------------------------------------------------------------
// Records

function record(overrides: Partial<ActivityRecord> & { timestamp: string }): ActivityRecord {
  return {
    id: Math.random().toString(36).slice(2),
    app: 'Safari',
    windowTitle: 'Docs',
    trigger: 'burst-end',
    ...overrides,
  };
}

test('records round-trip through day files, sorted', () => {
  appendRecord(record({ timestamp: '2026-07-08T10:05:00.000Z' }));
  appendRecord(record({ timestamp: '2026-07-08T09:00:00.000Z' }));
  appendRecord(record({ timestamp: '2026-07-07T12:00:00.000Z' }));
  assert.deepEqual(listDays(), ['2026-07-08', '2026-07-07']);
  const day = readDay('2026-07-08');
  assert.equal(day.length, 2);
  assert.ok(day[0].timestamp < day[1].timestamp);
});

test('retention flags only days older than the window', () => {
  appendRecord(record({ timestamp: '2026-06-01T09:00:00.000Z' }));
  appendRecord(record({ timestamp: '2026-07-07T09:00:00.000Z' }));
  const old = daysPastRetention(14, new Date('2026-07-08T00:00:00Z'));
  assert.deepEqual(old, ['2026-06-01']);
});

test('observed-minutes estimate ignores long gaps', () => {
  const records = [
    record({ timestamp: '2026-07-08T09:00:00.000Z' }),
    record({ timestamp: '2026-07-08T09:04:00.000Z' }),
    record({ timestamp: '2026-07-08T13:00:00.000Z' }), // lunch gap — not "observed"
    record({ timestamp: '2026-07-08T13:03:00.000Z' }),
  ];
  assert.equal(estimateObservedMinutes(records), 7);
});
