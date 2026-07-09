import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beforeEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDayEvidence, loadRecap, saveRecap, summarizeDay } from '../dist/ambient/summarize.js';
import { shouldAutoRecap } from '../dist/ambient/observer.js';
import type { ActivityRecord, ActivitySegment } from '../dist/ambient/records.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-sum-'));
});

function seg(app: string, title: string, start: string, seconds: number, activeSeconds: number, extra: Partial<ActivitySegment> = {}): ActivitySegment {
  const end = new Date(Date.parse(start) + seconds * 1000).toISOString();
  return { app, windowTitle: title, start, end, seconds, activeSeconds, keys: 0, clicks: 0, ...extra };
}

test('summarizeDay aggregates time, ranks apps by active time, and pulls out sites', () => {
  const day = '2026-07-08';
  const segments: ActivitySegment[] = [
    seg('Cursor', 'observer.ts', `${day}T09:00:00.000Z`, 600, 600, { keys: 900, clicks: 40 }),
    seg('Google Chrome', 'Gmail', `${day}T09:15:00.000Z`, 300, 120, { keys: 50, clicks: 10, url: 'https://mail.google.com/mail/u/0' }),
    seg('Cursor', 'summarize.ts', `${day}T09:30:00.000Z`, 300, 300, { keys: 300, clicks: 15 }),
    seg('Google Chrome', 'docs', `${day}T10:00:00.000Z`, 120, 60, { url: 'https://docs.google.com/x' }),
  ];
  const s = summarizeDay(day, segments);

  assert.equal(s.day, day);
  assert.equal(s.segmentCount, 4);
  assert.equal(s.totalSeconds, 1320);
  assert.equal(s.activeSeconds, 1080);
  assert.equal(s.keys, 1250);
  assert.equal(s.clicks, 65);

  // Cursor has the most active time (900s) → ranks first.
  assert.equal(s.apps[0].app, 'Cursor');
  assert.equal(s.apps[0].activeSeconds, 900);
  assert.equal(s.apps[1].app, 'Google Chrome');

  // Sites aggregated by host (www-stripped), most time first.
  const hosts = s.sites.map((x) => x.host);
  assert.ok(hosts.includes('mail.google.com'));
  assert.ok(hosts.includes('docs.google.com'));

  // Busiest hour is 09 (local): the bulk of active time lands there.
  assert.ok(s.busiestHour);
});

test('buildDayEvidence interleaves segments and OCR digests chronologically', () => {
  const day = '2026-07-08';
  const segments: ActivitySegment[] = [
    seg('Cursor', 'MORNING.md — context-autopilot', `${day}T09:00:00.000Z`, 300, 280, { keys: 400 }),
    seg('Google Chrome', 'Submit to r/ClaudeAI', `${day}T09:10:00.000Z`, 240, 200, {
      keys: 500,
      url: 'https://www.reddit.com/r/ClaudeAI/submit',
    }),
    seg('Finder', 'Downloads', `${day}T09:20:00.000Z`, 5, 5), // <10s → dropped as flicker
  ];
  const records: ActivityRecord[] = [
    {
      id: 'r1',
      timestamp: `${day}T09:12:00.000Z`,
      app: 'Google Chrome',
      windowTitle: 'Submit to r/ClaudeAI',
      trigger: 'dwell',
      url: 'https://www.reddit.com/r/ClaudeAI/submit',
      text: 'Launching Context Autopilot: mine your sessions into CLAUDE.md rules',
    },
    { id: 'r2', timestamp: `${day}T09:01:00.000Z`, app: 'Cursor', windowTitle: 'MORNING.md', trigger: 'dwell' }, // no text → skipped
  ];
  const evidence = buildDayEvidence(segments, records);
  const lines = evidence.split('\n');
  assert.equal(lines.length, 3, 'two segments + one OCR digest; flicker and textless record dropped');
  assert.ok(lines[0].includes('MORNING.md'), 'chronological: Cursor first');
  assert.ok(lines[1].includes('reddit.com/r/ClaudeAI'), 'URL carried into evidence');
  assert.ok(lines[1].includes('typing (500 keys)'), 'typing cadence surfaces');
  assert.ok(lines[2].includes('screen showed: "Launching Context Autopilot'), 'OCR text lands in the log');
});

test('recaps persist: save → load round-trip, absent day → undefined', () => {
  assert.equal(loadRecap('2026-07-08'), undefined, 'nothing saved yet');
  const saved = saveRecap('2026-07-08', 'You shipped the ambient observer.', new Date('2026-07-08T21:00:00Z'));
  const loaded = loadRecap('2026-07-08');
  assert.deepEqual(loaded, saved);
  assert.equal(loaded!.narrative, 'You shipped the ambient observer.');
  assert.equal(loadRecap('2026-07-09'), undefined, 'other days untouched');
});

test('the automatic first-win recap fires once per day, after real work', () => {
  const HOURS = 3600;
  // Not enough observed work yet → stay quiet.
  assert.equal(shouldAutoRecap(undefined, '2026-07-08', 2 * HOURS), false);
  // Threshold crossed → fire.
  assert.equal(shouldAutoRecap(undefined, '2026-07-08', 3 * HOURS), true);
  // Already fired today → never again today, no matter how much more work.
  assert.equal(shouldAutoRecap('2026-07-08', '2026-07-08', 9 * HOURS), false);
  // A new day resets it.
  assert.equal(shouldAutoRecap('2026-07-08', '2026-07-09', 4 * HOURS), true);
});

test('summarizeDay on an empty day is well-formed and zeroed', () => {
  const s = summarizeDay('2026-07-08', []);
  assert.equal(s.segmentCount, 0);
  assert.equal(s.activeSeconds, 0);
  assert.deepEqual(s.apps, []);
  assert.deepEqual(s.sites, []);
  assert.equal(s.busiestHour, undefined);
});
