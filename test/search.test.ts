import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord, appendSegment, type ActivityRecord, type ActivitySegment } from '../dist/ambient/records.js';
import { searchHistory } from '../dist/ambient/search.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-search-'));
});

function rec(day: string, hhmm: string, app: string, title: string, text?: string, url?: string): ActivityRecord {
  return {
    id: `${day}-${hhmm}`,
    timestamp: `${day}T${hhmm}:00.000Z`,
    app,
    windowTitle: title,
    trigger: 'dwell',
    text,
    url,
  };
}

function seg(day: string, hhmm: string, app: string, title: string, url?: string): ActivitySegment {
  const start = `${day}T${hhmm}:00.000Z`;
  return {
    app,
    windowTitle: title,
    url,
    start,
    end: new Date(Date.parse(start) + 60_000).toISOString(),
    seconds: 60,
    activeSeconds: 60,
    keys: 0,
    clicks: 0,
  };
}

test('searchHistory finds OCR text with a snippet, newest first, across days', () => {
  appendRecord(rec('2026-07-08', '09:00', 'Chrome', 'Docs', 'the quarterly ERROR code X99 appeared during deploy'));
  appendRecord(rec('2026-07-09', '10:00', 'Terminal', 'zsh', 'build failed with error X99 in module foo'));
  appendRecord(rec('2026-07-09', '11:00', 'Mail', 'Inbox', 'nothing relevant here'));

  const hits = searchHistory('x99');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].day, '2026-07-09', 'newest first');
  assert.equal(hits[0].matched, 'text');
  assert.ok(hits[0].snippet.includes('error X99 in module foo'), 'snippet around the match');
  assert.equal(hits[1].day, '2026-07-08');
});

test('searchHistory matches titles and urls from segments too, deduped against records', () => {
  const day = '2026-07-09';
  // Same context in both streams within the same minute → one hit, not two.
  appendRecord(rec(day, '09:00', 'Chrome', 'Q3 Roadmap - Notion', 'roadmap items'));
  appendSegment(seg(day, '09:00', 'Chrome', 'Q3 Roadmap - Notion', 'https://notion.so/q3-roadmap'));
  // Segment-only context (no screenshot ever fired there).
  appendSegment(seg(day, '14:00', 'Safari', 'Flights to Tokyo', 'https://kayak.com/tokyo'));

  const roadmap = searchHistory('roadmap');
  assert.equal(roadmap.length, 1, 'record + covering segment dedupe to one hit');

  const tokyo = searchHistory('tokyo');
  assert.equal(tokyo.length, 1, 'segment-only context is searchable');
  assert.equal(tokyo[0].matched, 'title');
  assert.equal(tokyo[0].url, 'https://kayak.com/tokyo');
});

test('searchHistory guards: short queries return nothing; limit respected', () => {
  appendRecord(rec('2026-07-09', '09:00', 'Chrome', 'A', 'aaa bbb'));
  assert.equal(searchHistory('a').length, 0, 'single-char query rejected');
  for (let i = 0; i < 10; i++) appendRecord(rec('2026-07-09', `10:0${i}`.slice(0, 5), 'Chrome', `page ${i}`, 'needle'));
  assert.equal(searchHistory('needle', { limit: 5 }).length, 5);
});
