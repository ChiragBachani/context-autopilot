import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPromoteSignals,
  extractContextEntries,
  parseFrontmatter,
  scanAllProjectMemory,
  splitFacts,
} from '../dist/memory.js';
import type { MemoryEntry } from '../dist/memory.js';

const FACT_FILE = `---
name: test-fact
description: A one-line summary
metadata:
  type: feedback
---

Always run the linter before committing.

**Why:** The user asked twice.
`;

test('parseFrontmatter reads fields and separates the body', () => {
  const { fields, body } = parseFrontmatter(FACT_FILE);
  assert.equal(fields.name, 'test-fact');
  assert.equal(fields.description, 'A one-line summary');
  assert.equal(fields.type, 'feedback');
  assert.ok(body.includes('Always run the linter'));
  assert.ok(!body.includes('name: test-fact'));
});

test('parseFrontmatter without a fence returns the whole file as body', () => {
  const { fields, body } = parseFrontmatter('Just some notes.\nMore notes.');
  assert.deepEqual(fields, {});
  assert.equal(body, 'Just some notes.\nMore notes.');
});

test('parseFrontmatter with an unterminated fence treats everything as body', () => {
  const raw = '---\nname: broken\nno closing fence here';
  const { fields, body } = parseFrontmatter(raw);
  assert.deepEqual(fields, {});
  assert.equal(body, raw);
});

test('splitFacts splits on --- separator lines', () => {
  const facts = splitFacts('Fact one.\n\n---\n\nFact two.\n\n---\n\nFact three.');
  assert.equal(facts.length, 3);
  assert.equal(facts[0], 'Fact one.');
  assert.equal(facts[2], 'Fact three.');
});

test('extractContextEntries keeps bullets (incl. managed block), skips headings and fences', () => {
  const content = `# Heading

- First rule with detail
- Second rule

\`\`\`bash
- not a rule, inside a fence
\`\`\`

<!-- ctxlayer:begin -->
- **Managed rule** — do the managed thing.
<!-- ctxlayer:end -->

A short standalone paragraph that counts as an entry.
`;
  const entries = extractContextEntries(content);
  assert.ok(entries.some((e) => e.includes('First rule')));
  assert.ok(entries.some((e) => e.includes('Managed rule')));
  assert.ok(entries.some((e) => e.includes('standalone paragraph')));
  assert.ok(!entries.some((e) => e.includes('inside a fence')));
  assert.ok(!entries.some((e) => e.includes('Heading')));
  assert.ok(!entries.some((e) => e.includes('ctxlayer:begin')));
});

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), 'ctxlayer-home-'));
  const claudeDir = join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');

  // Real repo for project A, so context files can be scanned.
  const repoA = join(home, 'repo-a');
  await mkdir(repoA, { recursive: true });
  await writeFile(join(repoA, 'CLAUDE.md'), '# Repo A\n\n- Repo rule: always use tabs\n');

  const slugA = repoA.replace(/[^a-zA-Z0-9]/g, '-');
  const dirA = join(projectsDir, slugA);
  await mkdir(join(dirA, 'memory'), { recursive: true });
  await writeFile(join(dirA, 'session1.jsonl'), JSON.stringify({ cwd: repoA }) + '\n');
  await writeFile(
    join(dirA, 'memory', 'fact-linter.md'),
    '---\nname: fact-linter\ndescription: linter habit\nmetadata:\n  type: feedback\n---\n\nAlways run the linter before committing changes.\n',
  );
  await writeFile(
    join(dirA, 'memory', 'MEMORY.md'),
    '# Index\n\n- [Linter habit](fact-linter.md) — linter habit\n- [Orphan note](missing-file.md) — remember the standup is at nine thirty\n',
  );

  // Project B: repo dir deleted (cwd points nowhere), memory only.
  const dirB = join(projectsDir, '-Users-gone-repo-b');
  await mkdir(join(dirB, 'memory'), { recursive: true });
  await writeFile(join(dirB, 'session1.jsonl'), JSON.stringify({ cwd: join(home, 'deleted-repo') }) + '\n');
  await writeFile(
    join(dirB, 'memory', 'fact-linter.md'),
    '---\nname: fact-linter\ndescription: linter habit\n---\n\nAlways run the linter before committing changes.\n',
  );

  // Global slug (the home dir itself) — must be skipped.
  const globalSlug = home.replace(/[^a-zA-Z0-9]/g, '-');
  const dirG = join(projectsDir, globalSlug, 'memory');
  await mkdir(dirG, { recursive: true });
  await writeFile(join(dirG, 'global-fact.md'), 'This must never be scanned.\n');

  // Project with an empty memory dir and no transcripts.
  await mkdir(join(projectsDir, '-empty-project', 'memory'), { recursive: true });

  return { home, claudeDir, repoA, globalSlug };
}

test('scanAllProjectMemory scans facts, context files, orphan index lines; skips global', async () => {
  const { home, claudeDir, globalSlug } = await makeFixture();
  const scan = await scanAllProjectMemory({ claudeDir, homeDir: home });

  assert.equal(scan.projectsScanned, 2);
  assert.ok(scan.skippedGlobal.includes(globalSlug));

  const texts = scan.entries.map((e) => e.text);
  // Fact files from both projects.
  assert.equal(texts.filter((t) => t.includes('Always run the linter')).length, 2);
  // Context file entry from the live repo.
  assert.ok(texts.some((t) => t.includes('always use tabs')));
  // Orphan MEMORY.md line included; backed line excluded (no duplicate).
  assert.ok(texts.some((t) => t.includes('standup is at nine thirty')));
  assert.equal(texts.filter((t) => t.trim() === 'Linter habit — linter habit').length, 0);
  // Global layer's own memory never scanned.
  assert.ok(!texts.some((t) => t.includes('never be scanned')));
  // Deleted repo contributes memory but no context-file entries.
  const fromB = scan.entries.filter((e) => e.slug === '-Users-gone-repo-b');
  assert.ok(fromB.length > 0);
  assert.ok(fromB.every((e) => e.origin === 'memory'));
  // Frontmatter type flows through.
  const fact = scan.entries.find((e) => e.name === 'fact-linter' && e.type === 'feedback');
  assert.ok(fact);
});

function memEntry(text: string, project: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    text,
    file: `/fake/${project}/memory/fact.md`,
    origin: 'memory',
    slug: project,
    projectPath: `/repos/${project}`,
    mtime: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

test('buildPromoteSignals merges cross-project duplicates and drops global-covered entries', () => {
  const entries = [
    memEntry('Always run the linter before committing changes to any repository', 'proj-a'),
    // Paraphrased, not identical — clustering must still merge these.
    memEntry('Always run the linter before committing changes, in every repository', 'proj-b', {
      file: '/fake/proj-b/memory/fact.md',
    }),
    memEntry('Use the staging database for integration tests in this service', 'proj-a', {
      file: '/fake/proj-a/memory/fact2.md',
    }),
    memEntry('Keep responses short and reply in plain english without jargon words', 'proj-c'),
  ];
  const globalContext = '# Global\n\n- Keep responses short and reply in plain english without jargon words\n';
  const signals = buildPromoteSignals(entries, globalContext);

  // Global-covered entry dropped entirely.
  assert.ok(!signals.some((s) => s.summary.includes('plain english')));
  // Cross-project duplicate merged into one signal spanning 2 projects, ranked first.
  const linter = signals.find((s) => s.summary.includes('linter'));
  assert.ok(linter);
  assert.equal(linter.projects, 2);
  assert.equal(signals[0], linter);
  const single = signals.find((s) => s.summary.includes('staging database'));
  assert.ok(single);
  assert.ok(linter.score > single.score);
  // Evidence contract: sessionId carries the file path, timestamp the mtime.
  assert.equal(linter.observations[0].sessionId, '/fake/proj-a/memory/fact.md');
  assert.equal(linter.observations[0].timestamp, '2026-07-01T00:00:00.000Z');
});
