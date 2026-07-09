import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askActivity,
  buildAskEvidence,
  buildAssistPrompt,
  dayRefsFromQuestion,
  extractSearchTerms,
  loadHandoff,
  parseAskResponse,
  saveHandoff,
} from '../dist/ambient/ask.js';
import { appendRecord, appendSegment, type ActivityRecord, type ActivitySegment } from '../dist/ambient/records.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-ask-'));
});

// Thu 2026-07-09, 15:00 local.
const NOW = new Date(2026, 6, 9, 15, 0);

test('dayRefsFromQuestion resolves days and part-of-day spans', () => {
  const morning = dayRefsFromQuestion('what was I trying to achieve this morning?', NOW);
  assert.deepEqual(morning.map((s) => [s.day, s.startHour, s.endHour]), [['2026-07-09', 5, 12]]);

  const compare = dayRefsFromQuestion('did I solve it by the afternoon, or still stuck since morning?', NOW);
  assert.equal(compare.length, 2, 'morning + afternoon spans for comparison');
  assert.deepEqual(compare.map((s) => s.endHour).sort(), [12, 18]);

  const yest = dayRefsFromQuestion('what did I do yesterday evening?', NOW);
  assert.deepEqual(yest.map((s) => [s.day, s.startHour]), [['2026-07-08', 18]]);

  const monday = dayRefsFromQuestion('what happened on Monday?', NOW);
  assert.deepEqual(monday.map((s) => s.day), ['2026-07-06'], 'most recent past Monday');

  const none = dayRefsFromQuestion('how is my automation doing?', NOW);
  assert.deepEqual(none.map((s) => s.day), ['2026-07-09'], 'default = today, whole day');
  assert.equal(none[0].startHour, undefined);
});

test('extractSearchTerms keeps entities, drops stopwords and day words', () => {
  const terms = extractSearchTerms('What was I trying to achieve in chrome this morning about the TCC permissions error?');
  assert.ok(terms.includes('chrome'));
  assert.ok(terms.includes('tcc'));
  assert.ok(terms.includes('permissions'));
  assert.ok(!terms.includes('trying'));
  assert.ok(!terms.includes('morning'));
  assert.ok(terms.length <= 6);
});

function seg(day: string, hour: number, app: string, title: string, url?: string): ActivitySegment {
  const d = new Date(2026, 6, Number(day.slice(8)), hour, 0);
  return { app, windowTitle: title, url, start: d.toISOString(), end: new Date(d.getTime() + 600_000).toISOString(), seconds: 600, activeSeconds: 500, keys: 200, clicks: 5 };
}

function rec(day: string, hour: number, app: string, title: string, text: string): ActivityRecord {
  const d = new Date(2026, 6, Number(day.slice(8)), hour, 5);
  return { id: `${day}-${hour}`, timestamp: d.toISOString(), app, windowTitle: title, trigger: 'dwell', text };
}

test('buildAskEvidence: span-filtered trails + search hits + caps respected', () => {
  // Morning: debugging TCC. Afternoon: unrelated email.
  appendSegment(seg('2026-07-09', 9, 'Google Chrome', 'tcc reset unsigned app - Google Search', 'https://google.com/search?q=tcc'));
  appendRecord(rec('2026-07-09', 9, 'Google Chrome', 'tcc reset unsigned app - Google Search', 'Screen Recording permission denied CGPreflightScreenCaptureAccess'));
  appendSegment(seg('2026-07-09', 14, 'Mail', 'Inbox'));

  const spans = dayRefsFromQuestion('what was I doing this morning with the tcc error?', NOW);
  const terms = extractSearchTerms('what was I doing this morning with the tcc error?');
  const ev = buildAskEvidence(spans, terms, NOW);

  assert.ok(ev.text.includes('tcc reset unsigned app'), 'morning trail present');
  assert.ok(ev.text.includes('CGPreflightScreenCaptureAccess'), 'OCR text attached');
  assert.ok(!ev.text.split('## Activity trail')[1]?.includes('Inbox'), 'afternoon activity not in the morning span trail');
  assert.ok(ev.hits.length >= 1, 'search hits returned for receipts');
  assert.ok(ev.text.length <= 18_100, 'cap respected');
});

test('parseAskResponse: structured, structured+handoff, malformed → raw', () => {
  const plain = parseAskResponse('{"answer": "You were debugging TCC grants."}');
  assert.equal(plain.answer, 'You were debugging TCC grants.');
  assert.equal(plain.handoff, undefined);

  const withHandoff = parseAskResponse('{"answer": "Still unsolved.", "handoff": {"goal": "Fix the TCC grant", "context": "Tried re-toggling."}}');
  assert.equal(withHandoff.handoff!.goal, 'Fix the TCC grant');

  const raw = parseAskResponse('You were mostly in Chrome. No JSON here.');
  assert.equal(raw.answer, 'You were mostly in Chrome. No JSON here.');
});

test('askActivity: prompt carries interpretation rules, evidence, history; handoff saved', async () => {
  appendSegment(seg('2026-07-09', 9, 'Chrome', 'stackoverflow - tcc reset'));
  let seenPrompt = '';
  const fake = async (prompt: string) => {
    seenPrompt = prompt;
    return '{"answer": "You were fixing permissions.", "handoff": {"goal": "Finish the TCC fix", "context": "Toggled twice, still denied."}}';
  };
  const result = await askActivity('can you help me finish what I was doing this morning?', [{ q: 'earlier q', a: 'earlier a' }], { runModel: fake, now: NOW });

  assert.ok(seenPrompt.includes('TRYING TO ACHIEVE'), 'interpretation rules present');
  assert.ok(seenPrompt.includes('stackoverflow - tcc reset'), 'evidence present');
  assert.ok(seenPrompt.includes('earlier q'), 'conversation memory included');
  assert.equal(result.answer, 'You were fixing permissions.');
  assert.ok(result.handoff!.id, 'handoff persisted with an id');

  const stored = loadHandoff(result.handoff!.id);
  assert.equal(stored!.goal, 'Finish the TCC fix');
  const assist = buildAssistPrompt(stored!);
  assert.ok(assist.includes('Finish the TCC fix') && assist.includes('Toggled twice'), 'assist prompt carries goal + trail');
});
