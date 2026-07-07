import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDecisions, applyToFile, saveProposals } from '../dist/propose.js';
import type { AopEntry, ProposalFile } from '../dist/types.js';

function entry(title: string, rule: string): AopEntry {
  return { title, rule, rationale: '', confidence: 'high', evidence: [] };
}

test('applyToFile preserves hand-written content and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-'));
  await writeFile(join(dir, 'CLAUDE.md'), '# My project\n\nHand-written notes.\n');

  await applyToFile(dir, 'CLAUDE.md', [entry('Rule one', 'Do the thing.')]);
  let content = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes('Hand-written notes.'));
  assert.ok(content.includes('<!-- ctxlayer:begin -->'));
  assert.ok(content.includes('**Rule one** — Do the thing.'));

  // Re-apply with an updated rule and a new one: block updates in place.
  const result = await applyToFile(dir, 'CLAUDE.md', [
    entry('Rule one', 'Do the thing, updated.'),
    entry('Rule two', 'Never do the other thing.'),
  ]);
  content = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(result.total, 2);
  assert.ok(content.includes('Do the thing, updated.'));
  assert.ok(!content.includes('Do the thing.\n<!--'), 'old rule text should be replaced');
  assert.equal(content.match(/ctxlayer:begin/g)?.length, 1, 'exactly one managed block');
  assert.ok(content.indexOf('Hand-written notes.') < content.indexOf('ctxlayer:begin'));
});

test('applyDecisions applies accepts, remembers rejects, leaves rest pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-'));
  const file: ProposalFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectPath: dir,
    source: 'all',
    proposals: [
      { entry: entry('Rule A', 'Do A.'), targets: ['CLAUDE.md'], status: 'pending' },
      { entry: entry('Rule B', 'Do B.'), targets: ['CLAUDE.md'], status: 'pending' },
      { entry: entry('Rule C', 'Do C.'), targets: ['CLAUDE.md'], status: 'pending' },
    ],
  };
  await saveProposals(file);

  const result = await applyDecisions(dir, ['rule a'], ['Rule B', 'Rule Nonexistent']);
  assert.deepEqual(result.accepted, ['Rule A']);
  assert.deepEqual(result.rejected, ['Rule B']);
  assert.deepEqual(result.unmatched, ['rule nonexistent']);
  assert.equal(result.stillPending, 1);

  const content = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes('**Rule A** — Do A.'));
  assert.ok(!content.includes('Rule B'), 'rejected rule must not be written');
  assert.ok(!content.includes('Rule C'), 'pending rule must not be written');
});

test('applyToFile creates the file when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-'));
  const result = await applyToFile(dir, 'AGENTS.md', [entry('Rule', 'Be excellent.')]);
  assert.equal(result.created, true);
  const content = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(content.startsWith('# Agent guide'));
  assert.ok(content.includes('**Rule** — Be excellent.'));
});
