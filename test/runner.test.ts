import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunEvent,
  buildRunPrompt,
  isWebAop,
  newRunId,
  readRuns,
  scheduleCalendarXml,
  summaryPath,
} from '../dist/ambient/runner.js';
import { normalizeSchedule, type StoredAop } from '../dist/ambient/workflows.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-run-'));
});

function aop(overrides: Partial<StoredAop> = {}): StoredAop {
  return {
    format: 'aop/v1',
    slug: 'weekly-report',
    title: 'Weekly report',
    rule: 'Compile and send.',
    rationale: '',
    confidence: 'high',
    procedure: ['Open the tracker', 'Update numbers', 'Send the summary'],
    evidence: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'screen',
    ...overrides,
  };
}

test('isWebAop: url trigger or url-ish steps → chrome; desktop-only → plain', () => {
  assert.equal(isWebAop(aop({ trigger: { app: 'Chrome', urlPattern: 'mail.google.com' } })), true);
  assert.equal(isWebAop(aop({ procedure: ['Open https://sheets.google.com and update the tracker'] })), true);
  assert.equal(isWebAop(aop({ procedure: ['Go to reddit.com and check replies'] })), true);
  assert.equal(isWebAop(aop({ procedure: ['Open the Invoices folder in Finder', 'Rename the PDFs'] })), false);
});

test('run events fold into records: start+finish, duration, newest first, receipts join', () => {
  const id1 = newRunId(new Date('2026-07-09T09:00:00Z'));
  appendRunEvent({ id: id1, slug: 'weekly-report', event: 'start', at: '2026-07-09T09:00:00.000Z', mode: 'chrome', origin: 'manual' });
  appendRunEvent({ id: id1, slug: 'weekly-report', event: 'finish', at: '2026-07-09T09:04:00.000Z', exitCode: 0 });
  const id2 = newRunId(new Date('2026-07-09T10:00:00Z'));
  appendRunEvent({ id: id2, slug: 'weekly-report', event: 'start', at: '2026-07-09T10:00:00.000Z', mode: 'plain', origin: 'scheduled' });

  mkdirSync(join(process.env.CTXLAYER_HOME!, 'aops', 'runs'), { recursive: true });
  writeFileSync(summaryPath(id1), 'Sent the weekly summary to the team.', 'utf8');

  const runs = readRuns('weekly-report');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, id2, 'newest first');
  assert.equal(runs[0].finishedAt, undefined, 'in-flight run has no finish');
  assert.equal(runs[0].origin, 'scheduled');
  assert.equal(runs[1].exitCode, 0);
  assert.equal(runs[1].seconds, 240);
  assert.ok(runs[1].summary!.includes('weekly summary'), 'agent-written receipt joined');
  assert.equal(readRuns('other-slug').length, 0, 'slug filter');
});

test('the run prompt carries the procedure and the receipt instruction', () => {
  const prompt = buildRunPrompt(aop(), 'run123');
  assert.ok(prompt.includes('Open the tracker'), 'procedure present');
  assert.ok(prompt.includes('run123.md'), 'receipt path present');
  assert.ok(prompt.toLowerCase().includes('summary of what you actually did'), 'receipt instruction present');
});

test('schedule XML: weekday dicts or daily; normalizeSchedule clamps and dedupes', () => {
  const weekly = scheduleCalendarXml({ weekdays: [1, 5], hour: 9, minute: 30 });
  assert.equal((weekly.match(/<key>Weekday<\/key>/g) ?? []).length, 2);
  assert.ok(weekly.includes('<key>Hour</key><integer>9</integer>'));
  const daily = scheduleCalendarXml({ hour: 18, minute: 0 });
  assert.equal((daily.match(/<dict>/g) ?? []).length, 1, 'no weekday = one daily dict');
  assert.ok(!daily.includes('Weekday'));

  const norm = normalizeSchedule({ weekdays: [5, 1, 5, 9 as never], hour: 33, minute: -4 });
  assert.deepEqual(norm, { weekdays: [1, 5], hour: 23, minute: 0 });
});
