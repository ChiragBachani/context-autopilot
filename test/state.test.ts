import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshSignals, loadDistilledFingerprints, recordDistilledSignals, signalFingerprint } from '../dist/state.js';
import type { Signal } from '../dist/types.js';

function signal(summary: string, kind: Signal['kind'] = 'correction'): Signal {
  return { id: summary, kind, summary, observations: [], sessions: 1, projects: 1, score: 6 };
}

test('recorded signals stop being fresh; new ones remain fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-state-'));
  const a = signal('Never hardcode hex colors in the mockups');
  const b = signal('Always click-test every button before reporting done');

  await recordDistilledSignals(dir, [a]);
  const seen = await loadDistilledFingerprints(dir);
  const fresh = freshSignals([a, b], seen);
  assert.deepEqual(fresh.map((s) => s.summary), [b.summary]);
});

test('fingerprint tolerates growth of the cluster tail', () => {
  const before = signal('Do not add responsive CSS to the mockup files they stay fixed width by design okay');
  const after = signal('Do not add responsive CSS to the mockup files they stay fixed width by design okay and always');
  assert.equal(signalFingerprint(before), signalFingerprint(after));
});
