import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolAccesses } from '../dist/sources/claude-code.js';
import type { ToolAccess } from '../dist/sources/claude-code.js';
import {
  aggregateAccesses,
  applyCodemap,
  parseCodemap,
  renderCodemapBlock,
} from '../dist/codemap.js';

/** Build a fake ~/.claude/projects root with one session transcript. */
async function fixtureRoot(projectPath: string, toolCalls: { name: string; input: unknown }[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ctxlayer-projects-'));
  const slug = join(root, 'slug-abc');
  await mkdir(slug, { recursive: true });
  const lines: string[] = [];
  // First line carries cwd so discover() maps this slug → projectPath.
  lines.push(JSON.stringify({ type: 'user', cwd: projectPath, sessionId: 's1', timestamp: '2026-07-08T09:00:00Z', message: { role: 'user', content: 'go' } }));
  for (const call of toolCalls) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-07-08T09:01:00Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: call.name, input: call.input }] },
      }),
    );
  }
  await writeFile(join(slug, 'session1.jsonl'), lines.join('\n') + '\n', 'utf8');
  return root;
}

test('readToolAccesses keeps in-project files, relativizes them, and drops noise', async () => {
  const proj = '/Users/dev/myrepo';
  const root = await fixtureRoot(proj, [
    { name: 'Read', input: { file_path: `${proj}/src/server.ts` } },
    { name: 'Edit', input: { file_path: `${proj}/src/server.ts` } },
    { name: 'Read', input: { file_path: `${proj}/node_modules/left-pad/index.js` } }, // ignored dir
    { name: 'Read', input: { file_path: '/etc/hosts' } }, // outside project
    { name: 'Grep', input: { pattern: 'handleRequest' } }, // identifier → kept
    { name: 'Grep', input: { pattern: 'export function' } }, // regex-ish → dropped
  ]);
  const accesses = await readToolAccesses(proj, root);
  const kinds = accesses.map((a) => `${a.kind}:${a.path ?? a.term}`).sort();
  assert.deepEqual(kinds, ['edit:src/server.ts', 'read:src/server.ts', 'search:handleRequest']);
});

test('aggregateAccesses ranks files by distinct sessions and filters weak symbols', () => {
  const accesses: ToolAccess[] = [
    // observer.ts touched in two sessions → load-bearing
    { kind: 'read', path: 'src/observer.ts', timestamp: 't', sessionId: 's1' },
    { kind: 'edit', path: 'src/observer.ts', timestamp: 't', sessionId: 's2' },
    { kind: 'read', path: 'src/util.ts', timestamp: 't', sessionId: 's1' },
    // "launchAopInTerminal" searched in two sessions → kept; "foo" once → dropped
    { kind: 'search', term: 'launchAopInTerminal', timestamp: 't', sessionId: 's1' },
    { kind: 'search', term: 'launchAopInTerminal', timestamp: 't', sessionId: 's2' },
    { kind: 'search', term: 'foo', timestamp: 't', sessionId: 's1' },
  ];
  const sig = aggregateAccesses(accesses);
  assert.equal(sig.sessionsAnalyzed, 2);
  assert.equal(sig.files[0].path, 'src/observer.ts', 'most-touched file ranks first');
  assert.equal(sig.files[0].sessions, 2);
  assert.equal(sig.files[0].reads, 1);
  assert.equal(sig.files[0].edits, 1);
  const terms = sig.symbols.map((s) => s.term);
  assert.ok(terms.includes('launchAopInTerminal'), 'symbol seen in 2 sessions is kept');
  assert.ok(!terms.includes('foo'), 'symbol seen once is dropped as noise');
});

test('parseCodemap tolerates prose around the JSON object', () => {
  const raw = 'Here is the map:\n{"files":[{"path":"src/a.ts","role":"the entry point"}],"notes":["X lives in a.ts"]}\nDone.';
  const result = parseCodemap(raw);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, 'src/a.ts');
  assert.deepEqual(result.notes, ['X lives in a.ts']);
});

test('renderCodemapBlock produces a self-delimiting managed block', () => {
  const block = renderCodemapBlock(
    { files: [{ path: 'src/a.ts', role: 'does A' }], notes: ['B lives in a.ts'] },
    new Date('2026-07-08T00:00:00Z'),
  );
  assert.ok(block.includes('<!-- ctxlayer:map:begin -->'));
  assert.ok(block.includes('<!-- ctxlayer:map:end -->'));
  assert.ok(block.includes('## Codebase map (Context Autopilot)'));
  assert.ok(block.includes('`src/a.ts` — does A'));
  assert.ok(block.includes('B lives in a.ts'));
  assert.ok(block.includes('2026-07-08'));
});

test('applyCodemap is idempotent and never touches hand-written content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-map-write-'));
  await writeFile(join(dir, 'CLAUDE.md'), '# Project context\n\nHand-written note that must survive.\n', 'utf8');

  const first = await applyCodemap(dir, 'CLAUDE.md', { files: [{ path: 'src/a.ts', role: 'v1 role' }], notes: [] });
  assert.equal(first.created, false);
  let content = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(content.includes('Hand-written note that must survive.'));
  assert.ok(content.includes('v1 role'));

  // Re-running replaces the block in place — no duplication, hand-written text intact.
  await applyCodemap(dir, 'CLAUDE.md', { files: [{ path: 'src/a.ts', role: 'v2 role' }], notes: [] });
  content = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(content.match(/ctxlayer:map:begin/g)?.length, 1, 'exactly one managed block');
  assert.ok(content.includes('v2 role'));
  assert.ok(!content.includes('v1 role'));
  assert.ok(content.includes('Hand-written note that must survive.'));
});

test('applyCodemap creates a context file when none exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-map-create-'));
  const res = await applyCodemap(dir, 'AGENTS.md', { files: [{ path: 'x.ts', role: 'r' }], notes: [] });
  assert.equal(res.created, true);
  const content = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(content.includes('# Agent guide'));
  assert.ok(content.includes('ctxlayer:map:begin'));
});
