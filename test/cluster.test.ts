import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignals } from '../dist/cluster.js';
import type { Observation } from '../dist/types.js';

function obs(partial: Partial<Observation> & { text: string }): Observation {
  return {
    id: Math.random().toString(36).slice(2),
    source: 'test',
    kind: 'instruction',
    timestamp: '2026-07-01T00:00:00Z',
    sessionId: 's1',
    ...partial,
  };
}

test('instructions repeated across sessions become a signal', () => {
  const signals = buildSignals([
    obs({ text: 'Use CSS custom properties, never hardcode hex colors', sessionId: 's1' }),
    obs({ text: 'Never hardcode hex colors — use the CSS custom properties', sessionId: 's2' }),
  ]);
  const repeated = signals.filter((s) => s.kind === 'repeated-instruction');
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].sessions, 2);
});

test('one-off instructions produce no signal', () => {
  const signals = buildSignals([
    obs({ text: 'Add a settings screen with two sections', sessionId: 's1' }),
    obs({ text: 'Deploy the app to Railway when done', sessionId: 's1' }),
  ]);
  assert.equal(signals.filter((s) => s.kind === 'repeated-instruction').length, 0);
});

test('a single correction is signal-worthy', () => {
  const signals = buildSignals([
    obs({ text: 'No — the week starts on Sunday, not Monday', kind: 'correction' }),
  ]);
  const corrections = signals.filter((s) => s.kind === 'correction');
  assert.equal(corrections.length, 1);
  assert.ok(corrections[0].score >= 4, 'correction score should clear the default threshold');
});

test('signals spanning multiple projects score higher and count projects', () => {
  const single = buildSignals([
    obs({ text: 'Give me a rundown first, do not take any actions yet', sessionId: 's1', project: '/a' }),
    obs({ text: 'Give me a rundown first and do not take any actions yet', sessionId: 's2', project: '/a' }),
  ]);
  const cross = buildSignals([
    obs({ text: 'Give me a rundown first, do not take any actions yet', sessionId: 's1', project: '/a' }),
    obs({ text: 'Give me a rundown first and do not take any actions yet', sessionId: 's2', project: '/b' }),
  ]);
  assert.equal(single[0].projects, 1);
  assert.equal(cross[0].projects, 2);
  assert.ok(cross[0].score > single[0].score, 'cross-project recurrence should outscore same-project');
});

test('signals are sorted by score descending', () => {
  const signals = buildSignals([
    obs({ text: 'Never hardcode colors', kind: 'correction', sessionId: 's1' }),
    obs({ text: 'Never hardcode any colors please', kind: 'correction', sessionId: 's2' }),
    obs({ text: 'A single lonely correction', kind: 'correction', sessionId: 's3' }),
  ]);
  for (let i = 1; i < signals.length; i++) {
    assert.ok(signals[i - 1].score >= signals[i].score);
  }
});
