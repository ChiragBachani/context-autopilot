import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSegment, type ActivitySegment } from '../dist/ambient/records.js';
import { buildWeekStats, weekDays, isoWeekKey } from '../dist/ambient/week.js';
import { withinTimeWindow } from '../dist/ambient/observer.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-week-'));
});

function seg(day: string, hhmm: string, app: string, activeSec: number): ActivitySegment {
  const start = `${day}T${hhmm}:00.000Z`;
  return { app, windowTitle: app, start, end: new Date(Date.parse(start) + activeSec * 1000).toISOString(), seconds: activeSec, activeSeconds: activeSec, keys: 0, clicks: 0 };
}

test('weekDays returns the 7 days ending inclusive, oldest first', () => {
  const days = weekDays('2026-07-09'); // Thursday
  assert.equal(days.length, 7);
  assert.equal(days[6], '2026-07-09');
  assert.equal(days[0], '2026-07-03');
});

test('buildWeekStats aggregates active time, top apps, and the prior-week trend', () => {
  // This week: 2 days of work.
  appendSegment(seg('2026-07-08', '09:00', 'Cursor', 1800));
  appendSegment(seg('2026-07-09', '10:00', 'Cursor', 1200));
  appendSegment(seg('2026-07-09', '11:00', 'Chrome', 600));
  // Prior week (the 7 days before 2026-07-03): one day.
  appendSegment(seg('2026-07-01', '09:00', 'Chrome', 1200));

  const stats = buildWeekStats('2026-07-09');
  assert.equal(stats.totalActiveSeconds, 3600, 'this week active = 30+20+10 min');
  assert.equal(stats.topApps[0].app, 'Cursor', 'Cursor is the busiest app');
  assert.equal(stats.priorActiveSeconds, 1200, 'prior week picked up');
  assert.equal(stats.days.length, 7);
});

test('isoWeekKey is stable within a week and rolls over', () => {
  assert.equal(isoWeekKey('2026-07-09'), isoWeekKey('2026-07-06'), 'same ISO week');
  assert.notEqual(isoWeekKey('2026-07-09'), isoWeekKey('2026-07-13'), 'next week differs');
});

test('withinTimeWindow gates by hour and weekday', () => {
  // Thursday 2026-07-09, 09:30 local.
  const thuMorning = new Date(2026, 6, 9, 9, 30);
  assert.equal(withinTimeWindow(undefined, thuMorning), true, 'no window = always');
  assert.equal(withinTimeWindow({ startHour: 8, endHour: 11 }, thuMorning), true, 'inside hours');
  assert.equal(withinTimeWindow({ startHour: 13, endHour: 17 }, thuMorning), false, 'outside hours');
  assert.equal(withinTimeWindow({ weekdays: [4], startHour: 8, endHour: 11 }, thuMorning), true, 'Thu allowed');
  assert.equal(withinTimeWindow({ weekdays: [1, 2], startHour: 8, endHour: 11 }, thuMorning), false, 'Mon/Tue only');
  // Overnight window 22–2 at 23:00.
  const night = new Date(2026, 6, 9, 23, 0);
  assert.equal(withinTimeWindow({ startHour: 22, endHour: 2 }, night), true, 'overnight wrap');
});
