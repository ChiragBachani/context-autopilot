import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecord } from '../dist/ambient/records.js';
import { ScreenAdapter } from '../dist/sources/screen.js';
import { getAdapters } from '../dist/engine.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-test-'));
});

test('nothing observed → no discoverable ambient project', async () => {
  const adapter = new ScreenAdapter();
  assert.deepEqual(await adapter.discover(), []);
});

test('observed days surface as one project with activity observations', async () => {
  appendRecord({
    id: 'r1',
    timestamp: '2026-07-07T09:02:00.000Z',
    app: 'Google Chrome',
    windowTitle: 'Inbox - Gmail',
    trigger: 'burst-end',
    text: 'weekly metrics export ready',
  });
  appendRecord({
    id: 'r2',
    timestamp: '2026-07-08T09:05:00.000Z',
    app: 'Finder',
    windowTitle: 'Downloads',
    trigger: 'context-switch',
  });

  const adapter = new ScreenAdapter();
  const projects = await adapter.discover();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessionCount, 2); // two observed days

  const observations = await adapter.observe(projects[0]);
  assert.equal(observations.length, 2);
  assert.equal(observations[0].kind, 'activity');
  assert.equal(observations[0].sessionId, '2026-07-07');
  assert.ok(observations[0].text.includes('[Google Chrome] Inbox - Gmail'));
  assert.ok(observations[0].text.includes('weekly metrics'));
});

test('the screen adapter joins only explicit screen scans, never "all"', () => {
  assert.equal(getAdapters('all').some((a) => a.name === 'screen'), false);
  assert.equal(getAdapters('screen').length, 1);
  assert.equal(getAdapters('screen')[0].name, 'screen');
});
