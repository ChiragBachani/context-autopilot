import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStaleReferences } from '../dist/stale.js';

test('reports missing files and scripts, ignores live ones and prose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-stale-'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src/index.ts'), 'export {}\n');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }),
  );
  await writeFile(
    join(dir, 'CLAUDE.md'),
    [
      '# Project',
      'Entry point is src/index.ts and legacy code lives in src/old/legacy.ts.',
      'Run `npm run build` then `npm run deploy:prod`.',
      'The stack is React/Next.js and the site is thecontextlayer.ai.',
      'Use `npm install` normally.',
    ].join('\n'),
  );

  const findings = await findStaleReferences(dir);
  const refs = findings.map((f) => `${f.kind}:${f.reference}`);
  assert.ok(refs.includes('missing-file:src/old/legacy.ts'), `missing file not flagged: ${refs}`);
  assert.ok(refs.some((r) => r.startsWith('missing-script:') && r.includes('deploy:prod')), `missing script not flagged: ${refs}`);
  // No false positives:
  assert.ok(!refs.some((r) => r.includes('src/index.ts')), 'live file wrongly flagged');
  assert.ok(!refs.some((r) => r.includes('Next.js')), 'framework name wrongly flagged');
  assert.ok(!refs.some((r) => r.includes('thecontextlayer.ai')), 'domain wrongly flagged');
  assert.ok(!refs.some((r) => r.includes('install')), 'npm builtin wrongly flagged');
});

test('clean context files produce no findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ctxlayer-stale-'));
  await writeFile(join(dir, 'CLAUDE.md'), '# Clean\nJust prose, no references.\n');
  assert.equal((await findStaleReferences(dir)).length, 0);
});
