import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aopsRoot, DEFAULT_CONFIG } from '../dist/ambient/config.js';
import { appendRecord, type ActivityRecord } from '../dist/ambient/records.js';
import { maybeAutoDistill } from '../dist/ambient/observer.js';
import {
  applyWorkflowDecisions,
  buildEpisodes,
  distillWorkflows,
  findWorkflowCandidates,
  loadAmbientState,
  loadAops,
  parseWorkflowEntries,
  saveWorkflowProposals,
  sequenceSimilarity,
  slugify,
  titleKey,
  type Episode,
} from '../dist/ambient/workflows.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-test-'));
});

function record(app: string, title: string, timestamp: string, text?: string): ActivityRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp,
    app,
    windowTitle: title,
    trigger: 'demo',
    text,
  };
}

/** The demo story, parameterized by day and a minute offset. */
function morning(day: string, offset = 0): ActivityRecord[] {
  const at = (m: number) => `${day}T09:${String(m + offset).padStart(2, '0')}:00.000Z`;
  return [
    record('Google Chrome', 'Inbox (14) - Gmail', at(2), 'weekly metrics export ready'),
    record('Finder', 'Downloads', at(5), 'weekly-metrics.csv'),
    record('Google Chrome', 'Q3 Metrics Tracker - Google Sheets', at(9), 'signups revenue churn'),
    record('Google Chrome', 'Compose: Weekly metrics summary - Gmail', at(16), 'to sarah subject weekly'),
  ];
}

// ---------------------------------------------------------------------------
// Episodes

test('titleKey normalizes away counters and noise', () => {
  assert.equal(titleKey('Inbox (14) - Gmail'), titleKey('Inbox (2) - Gmail'));
  assert.notEqual(titleKey('Inbox - Gmail'), titleKey('Compose - Gmail'));
});

test('episodes split on 15-minute gaps and collapse repeats', () => {
  const day = '2026-07-07';
  const records = [
    record('Mail', 'Inbox', `${day}T09:00:00.000Z`),
    record('Mail', 'Inbox', `${day}T09:02:00.000Z`), // same context — collapsed
    record('Sheets', 'Tracker', `${day}T09:05:00.000Z`),
    record('Slack', '#general', `${day}T11:00:00.000Z`), // >15 min later — new episode
  ];
  const episodes = buildEpisodes(day, records);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].steps.length, 2);
  assert.equal(episodes[1].steps.length, 1);
});

// ---------------------------------------------------------------------------
// Cross-day matching

test('the same morning routine on two days becomes a candidate', () => {
  const byDay = new Map<string, Episode[]>();
  byDay.set('2026-06-30', buildEpisodes('2026-06-30', morning('2026-06-30')));
  byDay.set('2026-07-07', buildEpisodes('2026-07-07', morning('2026-07-07', 3)));
  const candidates = findWorkflowCandidates(byDay);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].days, ['2026-06-30', '2026-07-07']);
});

test('a routine seen only once is not a candidate', () => {
  const byDay = new Map<string, Episode[]>();
  byDay.set('2026-07-07', buildEpisodes('2026-07-07', morning('2026-07-07')));
  assert.equal(findWorkflowCandidates(byDay).length, 0);
});

test('the same routine twice in ONE day surfaces on day one', () => {
  // Two occurrences separated by >15 min → two episodes, same day. Users
  // should see results of being observed without waiting for tomorrow.
  const day = '2026-07-08';
  const records = [...morning(day), ...morning(day, 40)];
  const byDay = new Map<string, Episode[]>([[day, buildEpisodes(day, records)]]);
  const candidates = findWorkflowCandidates(byDay);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].days, [day]);
  assert.equal(candidates[0].episodes.length, 2);
});

test('sequence similarity distinguishes alike and unlike flows', () => {
  const a = buildEpisodes('d', morning('2026-07-07'))[0].steps;
  const b = buildEpisodes('d', morning('2026-06-30', 2))[0].steps;
  assert.ok(sequenceSimilarity(a, b) > 0.9);
  const unrelated = buildEpisodes('d', [
    record('Xcode', 'ClearFocus', '2026-07-07T14:00:00.000Z'),
    record('Simulator', 'iPhone 16', '2026-07-07T14:05:00.000Z'),
    record('Safari', 'Swift docs', '2026-07-07T14:10:00.000Z'),
  ])[0].steps;
  assert.ok(sequenceSimilarity(a, unrelated) < 0.2);
});

// ---------------------------------------------------------------------------
// Distillation (model injected)

const MODEL_REPLY = JSON.stringify([
  {
    title: 'Weekly metrics report',
    rule: 'Every Tuesday, move the metrics CSV from Gmail into the tracker sheet and email a summary.',
    rationale: 'Same four steps, three mornings.',
    confidence: 'high',
    procedure: ['Fetch the CSV from Gmail', 'Update the tracker sheet', 'Draft the summary email'],
    trigger: { app: 'Google Chrome', titlePattern: 'Gmail' },
    evidence: [{ quote: '2026-07-07 09:02–09:16: Gmail → Finder → Sheets → Gmail', timestamp: '2026-07-07T09:02:00.000Z', sessionId: '2026-07-07' }],
  },
]);

function twoDayCandidates() {
  const byDay = new Map<string, Episode[]>();
  byDay.set('2026-06-30', buildEpisodes('2026-06-30', morning('2026-06-30')));
  byDay.set('2026-07-07', buildEpisodes('2026-07-07', morning('2026-07-07')));
  return findWorkflowCandidates(byDay);
}

test('distillWorkflows parses trigger and procedure from the model', async () => {
  const proposals = await distillWorkflows(twoDayCandidates(), { runModel: async () => MODEL_REPLY });
  assert.equal(proposals.length, 1);
  const entry = proposals[0].entry;
  assert.equal(entry.trigger?.app, 'Google Chrome');
  assert.equal(entry.procedure?.length, 3);
  assert.equal(proposals[0].status, 'pending');
});

test('previously rejected titles are never re-proposed', async () => {
  saveWorkflowProposals(await distillWorkflows(twoDayCandidates(), { runModel: async () => MODEL_REPLY }));
  applyWorkflowDecisions([], ['Weekly metrics report']);
  const again = await distillWorkflows(twoDayCandidates(), { runModel: async () => MODEL_REPLY });
  assert.equal(again.length, 0);
});

test('parseWorkflowEntries survives prose around the JSON and junk entries', () => {
  const raw = `Here you go:\n${JSON.stringify([
    { title: 'Good', procedure: ['a'], confidence: 'high' },
    { title: 'No procedure — dropped' },
    'garbage',
  ])}\nHope that helps!`;
  const entries = parseWorkflowEntries(raw);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Good');
});

// ---------------------------------------------------------------------------
// Approval → AOP store

test('accepting a proposal writes an enabled AOP with prompt markdown', async () => {
  saveWorkflowProposals(await distillWorkflows(twoDayCandidates(), { runModel: async () => MODEL_REPLY }));
  const result = applyWorkflowDecisions(['Weekly metrics report']);
  assert.deepEqual(result.accepted, ['Weekly metrics report']);
  assert.equal(result.stillPending, 0);

  const aops = loadAops();
  assert.equal(aops.length, 1);
  assert.equal(aops[0].slug, 'weekly-metrics-report');
  assert.equal(aops[0].enabled, true);
  assert.ok(existsSync(join(aopsRoot(), 'weekly-metrics-report.md')));
  const md = readFileSync(join(aopsRoot(), 'weekly-metrics-report.md'), 'utf8');
  assert.ok(md.includes('Fetch the CSV from Gmail'));
});

test('rejection is remembered in ambient state', async () => {
  saveWorkflowProposals(await distillWorkflows(twoDayCandidates(), { runModel: async () => MODEL_REPLY }));
  applyWorkflowDecisions([], ['Weekly metrics report']);
  assert.deepEqual(loadAmbientState().rejectedTitles, ['Weekly metrics report']);
  assert.equal(loadAops().length, 0);
});

test('slugify produces filesystem-safe slugs', () => {
  assert.equal(slugify('Weekly metrics report'), 'weekly-metrics-report');
  assert.equal(slugify('  Émail — l\'export (v2)!  '), 'mail-l-export-v2');
  assert.equal(slugify('!!!'), 'aop');
});

// ---------------------------------------------------------------------------
// Periodic auto-distill gating

test('auto-distill fires at sensible moments and is throttled afterwards', () => {
  const config = { ...DEFAULT_CONFIG }; // 120 min interval, 10 new moments
  let spawned = 0;
  const runDistill = () => void spawned++;
  const log = () => {};
  // The eval throttle is module state — space every call >5 min apart.
  let t = Date.now();
  const next = () => new Date((t += 6 * 60_000));

  // Active user → never fires, regardless of accumulated moments.
  assert.equal(maybeAutoDistill(config, 1, log, next(), runDistill), false, 'not while actively working');

  // Idle but too little material → no run.
  for (let i = 0; i < 3; i++) appendRecord(record('Mail', 'Inbox', new Date(t - 60_000 * (i + 1)).toISOString()));
  assert.equal(maybeAutoDistill(config, 120, log, next(), runDistill), false, 'too few new moments');

  // Enough new moments + idle → fires exactly once…
  for (let i = 0; i < 10; i++) appendRecord(record('Mail', 'Inbox', new Date(t - 1000 * (i + 1)).toISOString()));
  assert.equal(maybeAutoDistill(config, 120, log, next(), runDistill), true, 'fires when idle with enough material');
  assert.equal(spawned, 1);

  // …then the interval throttle holds even with more new material.
  for (let i = 0; i < 10; i++) appendRecord(record('Mail', 'Inbox', new Date(t + 1000 * (i + 1)).toISOString()));
  assert.equal(maybeAutoDistill(config, 120, log, next(), runDistill), false, 'throttled by the interval');
  assert.equal(spawned, 1);

  // Disabled via config → never fires.
  assert.equal(maybeAutoDistill({ ...config, autoDistillEveryMinutes: 0 }, 120, log, next(), runDistill), false);
});
