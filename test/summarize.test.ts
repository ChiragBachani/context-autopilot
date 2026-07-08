import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDay } from '../dist/ambient/summarize.js';
import type { ActivitySegment } from '../dist/ambient/records.js';

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

test('summarizeDay on an empty day is well-formed and zeroed', () => {
  const s = summarizeDay('2026-07-08', []);
  assert.equal(s.segmentCount, 0);
  assert.equal(s.activeSeconds, 0);
  assert.deepEqual(s.apps, []);
  assert.deepEqual(s.sites, []);
  assert.equal(s.busiestHour, undefined);
});
