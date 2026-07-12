/**
 * Project-memory scanner: reads the durable memory agents have already
 * written down per project — Claude Code auto-memory fact files under
 * ~/.claude/projects/<slug>/memory/ and each repo's CLAUDE.md / AGENTS.md —
 * and turns the entries into pseudo-Signals for the 'promote' distill scope,
 * which picks out the ones that belong in the user's global ~/.claude/CLAUDE.md.
 *
 * Read-only over project files: promotion is additive to the global file.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Observation, Signal } from './types.js';
import { normalizeForSimilarity, similarity } from './extract.js';
import { firstCwd } from './sources/claude-code.js';

/** Dropping an entry as already-covered must be conservative: high bar. */
const DUPLICATE_THRESHOLD = 0.5;
/** Merging paraphrased dupes across projects: same bar as transcript clustering. */
const CLUSTER_THRESHOLD = 0.3;
const MAX_ENTRY_CHARS = 400;
const MAX_ENTRIES_PER_CONTEXT_FILE = 60;

export interface MemoryEntry {
  /** One fact / rule, clipped to ~400 chars. */
  text: string;
  /** Absolute path of the file it came from. */
  file: string;
  origin: 'memory' | 'context-file';
  /** ~/.claude/projects slug the entry belongs to. */
  slug: string;
  /** Recovered real repo path, when known. */
  projectPath?: string;
  /** ISO mtime of the source file — stands in for an observation timestamp. */
  mtime: string;
  /** Frontmatter metadata.type ('feedback', 'project', …), when present. */
  type?: string;
  /** Frontmatter name, when present. */
  name?: string;
}

export interface MemoryScan {
  entries: MemoryEntry[];
  projectsScanned: number;
  /** Slugs skipped because they are the global layer itself. */
  skippedGlobal: string[];
}

export interface FrontmatterResult {
  fields: { name?: string; description?: string; type?: string };
  body: string;
}

/**
 * Parse the simple frontmatter auto-memory fact files use:
 * --- / name: x / description: y / metadata: / type: z / --- then body.
 * No fence → the whole file is body.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  const lines = raw.split('\n');
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  if (lines[start]?.trim() !== '---') return { fields: {}, body: raw };
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { fields: {}, body: raw };

  const fields: FrontmatterResult['fields'] = {};
  let inMetadata = false;
  for (const line of lines.slice(start + 1, end)) {
    const m = line.match(/^(\s*)([A-Za-z_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, indent, key, value] = m;
    if (indent.length === 0) {
      inMetadata = key === 'metadata';
      if (key === 'name' && value) fields.name = value.trim();
      if (key === 'description' && value) fields.description = value.trim();
    } else if (inMetadata && key === 'type' && value) {
      fields.type = value.trim();
    }
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/** Split a fact-file body on `---` horizontal-rule lines: one fact each. */
export function splitFacts(body: string): string[] {
  return body
    .split(/^\s*---\s*$/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

/**
 * Pull candidate entries out of a project CLAUDE.md / AGENTS.md: top-level
 * bullets (with their indented continuations) and short standalone
 * paragraphs. Headings, code fences, and ctxlayer marker comments are
 * skipped; bullets inside the managed block are kept — a learned rule
 * duplicated across repos is a prime promotion candidate.
 */
export function extractContextEntries(content: string): string[] {
  const entries: string[] = [];
  let inFence = false;
  let current: string[] = [];
  let currentIsBullet = false;

  const flush = () => {
    const text = current.join(' ').replace(/\s+/g, ' ').trim();
    current = [];
    if (!text || text.length > MAX_ENTRY_CHARS * 2) return;
    if (entries.length < MAX_ENTRIES_PER_CONTEXT_FILE) entries.push(clip(text));
  };

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) {
      flush();
      continue;
    }
    if (/^[-*] /.test(trimmed)) {
      flush();
      current = [trimmed.replace(/^[-*] /, '')];
      currentIsBullet = true;
      continue;
    }
    if (currentIsBullet && /^\s+\S/.test(line)) {
      current.push(trimmed); // indented continuation of the bullet
      continue;
    }
    if (currentIsBullet) flush();
    currentIsBullet = false;
    current.push(trimmed); // paragraph text
  }
  flush();
  return entries;
}

export interface ScanOptions {
  /** Defaults to ~/.claude; injectable for tests. */
  claudeDir?: string;
  /** Defaults to os.homedir(); injectable for tests. */
  homeDir?: string;
}

/** Same slugging Claude Code applies to project paths. */
function slugify(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Walk every project slug under <claudeDir>/projects and collect memory
 * entries. The global layer's own sessions/memory (the home-dir slug, or
 * anything resolving to ~ or inside ~/.claude) are skipped — we promote
 * INTO the global layer, never out of it.
 */
export async function scanAllProjectMemory(opts: ScanOptions = {}): Promise<MemoryScan> {
  const home = opts.homeDir ?? homedir();
  const claudeDir = opts.claudeDir ?? join(home, '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const globalSlug = slugify(home);

  let slugs: string[];
  try {
    slugs = await readdir(projectsDir);
  } catch {
    return { entries: [], projectsScanned: 0, skippedGlobal: [] };
  }

  const entries: MemoryEntry[] = [];
  const skippedGlobal: string[] = [];
  let projectsScanned = 0;

  for (const slug of slugs) {
    const slugDir = join(projectsDir, slug);
    try {
      if (!(await stat(slugDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    if (slug === globalSlug) {
      skippedGlobal.push(slug);
      continue;
    }

    const projectPath = await recoverProjectPath(slugDir);
    if (projectPath) {
      const resolved = resolve(projectPath);
      if (resolved === resolve(home) || resolved.startsWith(resolve(claudeDir))) {
        skippedGlobal.push(slug);
        continue;
      }
    }

    const before = entries.length;
    entries.push(...(await scanMemoryDir(join(slugDir, 'memory'), slug, projectPath)));
    if (projectPath && existsSync(projectPath)) {
      entries.push(...(await scanContextFiles(projectPath, slug)));
    }
    if (entries.length > before) projectsScanned++;
  }

  return { entries, projectsScanned, skippedGlobal };
}

/** Real repo path from the newest transcript's cwd, like discover() does. */
async function recoverProjectPath(slugDir: string): Promise<string | undefined> {
  let files: string[];
  try {
    files = (await readdir(slugDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  let newest = files[0];
  let newestM = 0;
  for (const f of files) {
    try {
      const s = await stat(join(slugDir, f));
      if (s.mtimeMs > newestM) {
        newestM = s.mtimeMs;
        newest = f;
      }
    } catch {
      continue;
    }
  }
  try {
    return await firstCwd(join(slugDir, newest));
  } catch {
    return undefined;
  }
}

/**
 * Read all fact files in a memory/ dir. MEMORY.md is an index (one pointer
 * line per fact file), so scanning it whole would double-count; we keep only
 * its orphan lines — ones with no similar fact entry backing them.
 */
async function scanMemoryDir(
  memoryDir: string,
  slug: string,
  projectPath: string | undefined,
): Promise<MemoryEntry[]> {
  let files: string[];
  try {
    files = (await readdir(memoryDir)).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: MemoryEntry[] = [];
  let indexRaw: { content: string; mtime: string } | undefined;

  for (const file of files) {
    const filePath = join(memoryDir, file);
    let content: string;
    let mtime: string;
    try {
      content = await readFile(filePath, 'utf8');
      mtime = (await stat(filePath)).mtime.toISOString();
    } catch {
      continue;
    }
    if (file === 'MEMORY.md') {
      indexRaw = { content, mtime };
      continue;
    }
    const { fields, body } = parseFrontmatter(content);
    for (const fact of splitFacts(body)) {
      out.push({
        text: clip(fact),
        file: filePath,
        origin: 'memory',
        slug,
        projectPath,
        mtime,
        type: fields.type,
        name: fields.name,
      });
    }
  }

  if (indexRaw) {
    const factWords = out.map((e) => normalizeForSimilarity(e.text));
    for (const line of indexRaw.content.split('\n')) {
      const trimmed = line.trim();
      if (!/^[-*] /.test(trimmed)) continue;
      // Index lines link their fact file: [Title](file.md) — hook. A line
      // whose target still exists is already covered by the fact scan above.
      const link = trimmed.match(/\]\(([^)]+\.md)\)/);
      if (link && existsSync(join(memoryDir, link[1]))) continue;
      const text = trimmed.replace(/^[-*] /, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      const words = normalizeForSimilarity(text);
      if (factWords.some((fw) => similarity(words, fw) >= DUPLICATE_THRESHOLD)) continue;
      out.push({
        text: clip(text),
        file: join(memoryDir, 'MEMORY.md'),
        origin: 'memory',
        slug,
        projectPath,
        mtime: indexRaw.mtime,
      });
    }
  }
  return out;
}

async function scanContextFiles(projectPath: string, slug: string): Promise<MemoryEntry[]> {
  const out: MemoryEntry[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const filePath = join(projectPath, name);
    let content: string;
    let mtime: string;
    try {
      content = await readFile(filePath, 'utf8');
      mtime = (await stat(filePath)).mtime.toISOString();
    } catch {
      continue;
    }
    for (const text of extractContextEntries(content)) {
      out.push({ text, file: filePath, origin: 'context-file', slug, projectPath, mtime });
    }
  }
  return out;
}

/**
 * Turn memory entries into pseudo-Signals for distill({scope: 'promote'}).
 * Entries already covered by the global context are dropped mechanically
 * (which also keeps re-runs quiet after acceptance); near-duplicates from
 * different projects merge into one signal whose project spread is the
 * promotion evidence. Observation sessionId/timestamp carry the source file
 * path and mtime so proposal evidence points back at the file.
 */
export function buildPromoteSignals(entries: MemoryEntry[], globalContext: string): Signal[] {
  const globalLines = globalContext
    .split('\n')
    .map((l) => l.replace(/^[-*#>\s]+/, '').trim())
    .filter((l) => l.length > 10)
    .map((l) => normalizeForSimilarity(l));

  const fresh = entries.filter((e) => {
    const words = normalizeForSimilarity(e.text);
    if (words.length === 0) return false;
    return !globalLines.some((gl) => similarity(words, gl) >= DUPLICATE_THRESHOLD);
  });

  // Greedy single-pass clustering, same shape as cluster.ts groupBySimilarity.
  const clusters: MemoryEntry[][] = [];
  const clusterWords: string[][] = [];
  for (const entry of fresh) {
    const words = normalizeForSimilarity(entry.text);
    let placed = false;
    for (let i = 0; i < clusters.length; i++) {
      if (similarity(words, clusterWords[i]) >= CLUSTER_THRESHOLD) {
        clusters[i].push(entry);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([entry]);
      clusterWords.push(words);
    }
  }

  const signals: Signal[] = clusters.map((cluster, i) => {
    const projects = new Set(cluster.map((e) => e.projectPath ?? e.slug)).size;
    const files = new Set(cluster.map((e) => e.file)).size;
    const feedback = cluster.some((e) => e.type === 'feedback');
    let summary = cluster[0].text;
    for (const e of cluster) if (e.text.length < summary.length) summary = e.text;
    const observations: Observation[] = cluster.map((e, j) => ({
      id: `mem-${i}-${j}`,
      source: 'memory',
      kind: 'instruction',
      timestamp: e.mtime,
      sessionId: e.file,
      project: e.projectPath ?? e.slug,
      text: e.text,
    }));
    return {
      id: `mem-${i}`,
      kind: 'repeated-instruction',
      summary,
      observations,
      sessions: files,
      projects,
      score: projects * 3 + (feedback ? 2 : 0) + 1,
    };
  });

  signals.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const am = a.observations[0]?.timestamp ?? '';
    const bm = b.observations[0]?.timestamp ?? '';
    return bm.localeCompare(am);
  });
  return signals;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > MAX_ENTRY_CHARS ? t.slice(0, MAX_ENTRY_CHARS) + '…' : t;
}
