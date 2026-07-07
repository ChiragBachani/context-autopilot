/**
 * Staleness detection: find references in CLAUDE.md / AGENTS.md that the
 * repo has outgrown — files that no longer exist and npm scripts that were
 * removed. Context files rot silently; agents follow the rot.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface StaleFinding {
  file: string;
  line: number;
  kind: 'missing-file' | 'missing-script';
  reference: string;
  detail: string;
}

/** Path-like tokens: at least one separator and a file extension. */
const PATH_PATTERN = /(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+\.[a-z]{1,6}\b|[\w-]+\.(?:md|json|ts|tsx|js|jsx|py|html|css|ya?ml|toml|sql|sh)\b/g;
const SCRIPT_PATTERN = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([a-z][\w:-]*)/g;

/** npm subcommands that aren't scripts from package.json. */
const NPM_BUILTINS = new Set([
  'install', 'ci', 'publish', 'pack', 'login', 'logout', 'view', 'init', 'link',
  'update', 'audit', 'exec', 'create', 'add', 'remove', 'why', 'outdated', 'run',
]);

function looksCheckable(token: string): boolean {
  if (token.includes('<') || token.includes('*') || token.includes('$')) return false;
  if (token.startsWith('~')) return false;
  if (/^(https?|file):/.test(token)) return false;
  if (token.includes('node_modules') || token.includes('dist/')) return false;
  // Skip domains masquerading as paths (thecontextlayer.ai, example.com/x).
  if (/^[\w-]+\.(?:ai|com|dev|io|org|net|app)(?:\/|$)/.test(token)) return false;
  // Skip framework names that look like files: Next.js, Vue.js, React/Next.js.
  const basename = token.split('/').pop() ?? token;
  if (/^[A-Z][a-zA-Z]*\.js$/.test(basename)) return false;
  return true;
}

export async function findStaleReferences(projectPath: string): Promise<StaleFinding[]> {
  const findings: StaleFinding[] = [];
  let scripts: Set<string> | undefined;
  try {
    const pkg = JSON.parse(await readFile(join(projectPath, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    scripts = new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    scripts = undefined; // no package.json — skip script checks
  }

  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const contextPath = join(projectPath, name);
    if (!existsSync(contextPath)) continue;
    const lines = (await readFile(contextPath, 'utf8')).split('\n');
    const seen = new Set<string>();
    lines.forEach((lineText, i) => {
      for (const match of lineText.matchAll(PATH_PATTERN)) {
        const token = match[0];
        if (!looksCheckable(token) || seen.has(token)) continue;
        // Bare filenames (no slash) are too ambiguous unless they clearly
        // name a doc/config at the repo root.
        if (!token.includes('/') && !/\.(md|json|html)$/.test(token)) continue;
        const candidate = isAbsolute(token) ? token : join(projectPath, token);
        if (!existsSync(candidate)) {
          seen.add(token);
          findings.push({
            file: name,
            line: i + 1,
            kind: 'missing-file',
            reference: token,
            detail: `referenced file not found at ${candidate}`,
          });
        }
      }
      if (scripts) {
        for (const match of lineText.matchAll(SCRIPT_PATTERN)) {
          const script = match[1];
          const viaRun = /\brun\s/.test(match[0]);
          if (!viaRun && NPM_BUILTINS.has(script)) continue;
          if (!viaRun && !scripts.has(script)) continue; // bare `npm foo` that isn't a script — ignore
          if (viaRun && !scripts.has(script) && !seen.has(`script:${script}`)) {
            seen.add(`script:${script}`);
            findings.push({
              file: name,
              line: i + 1,
              kind: 'missing-script',
              reference: match[0],
              detail: `"${script}" is not in package.json scripts`,
            });
          }
        }
      }
    });
  }
  return findings;
}
