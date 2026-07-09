import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aopsRoot, DEFAULT_CONFIG } from '../dist/ambient/config.js';
import { appendRecord, appendSegment, type ActivityRecord, type ActivitySegment } from '../dist/ambient/records.js';
import { maybeAutoDistill, SegmentTracker } from '../dist/ambient/observer.js';
import {
  allDayMoments,
  applyWorkflowDecisions,
  buildDayMoments,
  buildEpisodes,
  createAop,
  deleteAop,
  distillSingleEpisode,
  distillWorkflows,
  findWorkflowCandidates,
  loadAmbientState,
  loadAops,
  parseWorkflowEntries,
  saveWorkflowProposals,
  sequenceSimilarity,
  slugify,
  titleKey,
  updateAop,
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
// Moments — the miner must see ALL context, not just screenshot records

function segment(app: string, title: string, start: string, seconds: number, url?: string): ActivitySegment {
  const end = new Date(Date.parse(start) + seconds * 1000).toISOString();
  return { app, windowTitle: title, url, start, end, seconds, activeSeconds: seconds, keys: 0, clicks: 0 };
}

test('a repeated routine visible ONLY in the activity log becomes a candidate', () => {
  // Segments only — zero screenshot records on disk. The miner must still see it.
  const day = '2026-07-09';
  const routine = (offsetMin: number) => {
    const at = (m: number) => new Date(Date.parse(`${day}T09:00:00.000Z`) + (offsetMin + m) * 60_000).toISOString();
    appendSegment(segment('Google Chrome', 'Inbox - Gmail', at(0), 120, 'https://mail.google.com/mail/u/0'));
    appendSegment(segment('Finder', 'Downloads', at(3), 60));
    appendSegment(segment('Google Chrome', 'Q3 Tracker - Sheets', at(5), 180, 'https://docs.google.com/spreadsheets/d/AB/edit'));
  };
  routine(0);
  routine(40); // second occurrence, >15 min later → separate episode

  const byDay = allDayMoments();
  assert.ok(byDay.has(day), 'segments-only day is discovered');
  const episodesByDay = new Map([[day, buildEpisodes(day, byDay.get(day)!)]]);
  const candidates = findWorkflowCandidates(episodesByDay);
  assert.equal(candidates.length, 1, 'the activity-log-only routine surfaces as a pattern candidate');
  assert.equal(candidates[0].episodes.length, 2);
});

test('buildDayMoments attaches OCR text from records to the covering segment', () => {
  const day = '2026-07-09';
  appendSegment(segment('Cursor', 'notes.md', `${day}T10:00:00.000Z`, 300));
  appendRecord({
    id: 'r1',
    timestamp: `${day}T10:02:00.000Z`, // inside the segment, same app/title
    app: 'Cursor',
    windowTitle: 'notes.md',
    trigger: 'dwell',
    text: 'launch checklist: post to r/ClaudeAI',
  });
  appendRecord({
    id: 'r2',
    timestamp: `${day}T11:00:00.000Z`, // no covering segment → kept as its own moment
    app: 'Preview',
    windowTitle: 'invoice.pdf',
    trigger: 'new-page',
    text: 'INVOICE #42',
  });
  const moments = buildDayMoments(day);
  assert.equal(moments.length, 2, 'one merged segment-moment + one standalone record');
  assert.equal(moments[0].app, 'Cursor');
  assert.ok(moments[0].text?.includes('launch checklist'), 'OCR attached to the covering segment');
  assert.equal(moments[1].app, 'Preview', 'record outside segments survives as its own moment');
});

// ---------------------------------------------------------------------------
// Activity segment tracking

test('SegmentTracker closes a segment on context change with active time + cadence', () => {
  const t = new SegmentTracker();
  const S = 1000;
  // Chrome for 3 ticks (2s each), user active, typing.
  assert.equal(t.sample({ now: 0, app: 'Chrome', title: 'Gmail', idleSeconds: 0, keys: 100, clicks: 10 }), null);
  assert.equal(t.sample({ now: 2 * S, app: 'Chrome', title: 'Gmail', idleSeconds: 0, keys: 130, clicks: 12 }), null);
  assert.equal(t.sample({ now: 4 * S, app: 'Chrome', title: 'Gmail', idleSeconds: 0, keys: 150, clicks: 15 }), null);
  // Switch to Slack → the Chrome segment is emitted.
  const seg = t.sample({ now: 6 * S, app: 'Slack', title: '#general', idleSeconds: 0, keys: 150, clicks: 15 });
  assert.ok(seg, 'context change emits the finished segment');
  assert.equal(seg!.app, 'Chrome');
  assert.equal(seg!.windowTitle, 'Gmail');
  assert.equal(seg!.seconds, 4, 'start 0 → last sample at 4s');
  assert.equal(seg!.activeSeconds, 4, 'never idle → all active');
  assert.equal(seg!.keys, 50, '150 − 100 keydowns');
  assert.equal(seg!.clicks, 5, '15 − 10 clicks');
});

test('SegmentTracker counts idle time as inactive and drops sub-flicker segments', () => {
  const t = new SegmentTracker();
  const S = 1000;
  // Active 2s, then idle for the next stretch.
  t.sample({ now: 0, app: 'Xcode', title: 'App.swift', idleSeconds: 0, keys: 0, clicks: 0 });
  t.sample({ now: 2 * S, app: 'Xcode', title: 'App.swift', idleSeconds: 1, keys: 5, clicks: 0 });
  t.sample({ now: 4 * S, app: 'Xcode', title: 'App.swift', idleSeconds: 120, keys: 5, clicks: 0 });
  const seg = t.flush()!;
  assert.equal(seg.seconds, 4);
  assert.equal(seg.activeSeconds, 2, 'only the first 2s counted as active');

  // A flicker (<4s) is discarded.
  const t2 = new SegmentTracker();
  t2.sample({ now: 0, app: 'Finder', title: 'Downloads', idleSeconds: 0, keys: 0, clicks: 0 });
  const flick = t2.sample({ now: 1 * S, app: 'Mail', title: 'Inbox', idleSeconds: 0, keys: 0, clicks: 0 });
  assert.equal(flick, null, 'a 1-second Finder blip is not recorded');
});

// ---------------------------------------------------------------------------
// Manual automation: single-episode distill + edit + create

test('distillSingleEpisode turns one episode into an AOP entry (no recurrence needed)', async () => {
  const episode = buildEpisodes('2026-07-09', morning('2026-07-09'))[0];
  const fakeModel = async (prompt: string) => {
    assert.ok(prompt.includes('Automate this'), 'prompt carries the explicit-intent override');
    assert.ok(prompt.includes('Inbox (14) - Gmail'), 'episode evidence is in the prompt');
    return JSON.stringify([
      {
        title: 'Weekly metrics email',
        rule: 'Compile the weekly metrics and email the summary.',
        rationale: 'user-confirmed',
        confidence: 'medium',
        procedure: ['Open Gmail', 'Download the export', 'Update the tracker', 'Send the summary'],
        trigger: { app: 'Google Chrome', urlPattern: 'mail.google.com' },
        evidence: [],
      },
    ]);
  };
  const entry = await distillSingleEpisode(episode, { runModel: fakeModel });
  assert.ok(entry);
  assert.equal(entry!.title, 'Weekly metrics email');
  assert.equal(entry!.procedure!.length, 4);
  assert.equal(entry!.trigger!.urlPattern, 'mail.google.com');
});

test('createAop and updateAop round-trip; slug stays stable through a rename', () => {
  const created = createAop({
    title: 'Send invoices',
    rule: 'First of the month.',
    procedure: ['Open the invoices folder', 'Generate PDFs', 'Email them'],
    trigger: { app: 'Finder', titlePattern: 'Invoices' },
  });
  assert.equal(created.source, 'manual');
  assert.equal(created.slug, 'send-invoices');
  assert.equal(created.enabled, true);

  const updated = updateAop('send-invoices', {
    title: 'Send monthly invoices',
    procedure: ['Open the invoices folder', 'Generate PDFs', 'Email them', 'Log in the tracker'],
    trigger: null, // clear the live trigger
  });
  assert.ok(updated);
  assert.equal(updated!.slug, 'send-invoices', 'slug is identity — rename does not move the file');
  assert.equal(updated!.title, 'Send monthly invoices');
  assert.equal(updated!.procedure.length, 4);
  assert.equal(updated!.trigger, undefined, 'trigger cleared');

  const reloaded = loadAops().find((a) => a.slug === 'send-invoices');
  assert.equal(reloaded!.title, 'Send monthly invoices', 'persisted to disk');
  assert.equal(updateAop('nope', { title: 'x' }), undefined, 'unknown slug → undefined');

  assert.equal(deleteAop('send-invoices'), true, 'delete removes it');
  assert.equal(loadAops().find((a) => a.slug === 'send-invoices'), undefined);
  assert.equal(deleteAop('send-invoices'), false, 'double delete → false');
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
