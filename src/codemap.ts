/**
 * Codebase map: distill "what agents keep having to look up" into an
 * evidence-backed architecture note in the project's context file.
 *
 * Context Autopilot already mines what the *human* repeats. This mines what the
 * *agent* re-derives every cold session — the files it reads, edits, and greps
 * for before it can act — and writes a concise map of the codebase so the next
 * session starts warm. Same philosophy as the rest of the product: grounded in
 * real evidence (actual tool calls), written to a managed block you approve.
 *
 * Source: Claude Code transcripts (see readToolAccesses in sources/claude-code).
 * The aggregation and rendering here are source-agnostic.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runModel } from './distill.js';
import { readToolAccesses, type ToolAccess } from './sources/claude-code.js';

const BEGIN = '<!-- ctxlayer:map:begin -->';
const END = '<!-- ctxlayer:map:end -->';
const HEADING = '## Codebase map (Context Autopilot)';

const MAX_FILES = 12;
const MAX_SYMBOLS = 10;
const MIN_SYMBOL_EVIDENCE = 2; // searched in ≥2 sessions or ≥2× — else it's noise

// ---------------------------------------------------------------------------
// Aggregation

export interface FileStat {
  path: string;
  reads: number;
  edits: number;
  /** Distinct sessions that touched this file — the load-bearing signal. */
  sessions: number;
}

export interface SymbolStat {
  term: string;
  count: number;
  sessions: number;
}

export interface CodemapSignals {
  files: FileStat[];
  symbols: SymbolStat[];
  sessionsAnalyzed: number;
  accessCount: number;
}

/** Fold raw accesses into ranked per-file and per-symbol frequency signals. */
export function aggregateAccesses(accesses: ToolAccess[]): CodemapSignals {
  const files = new Map<string, { reads: number; edits: number; sessions: Set<string> }>();
  const symbols = new Map<string, { count: number; sessions: Set<string> }>();
  const allSessions = new Set<string>();

  for (const a of accesses) {
    allSessions.add(a.sessionId);
    if (a.kind === 'search' && a.term) {
      const s = symbols.get(a.term) ?? { count: 0, sessions: new Set() };
      s.count += 1;
      s.sessions.add(a.sessionId);
      symbols.set(a.term, s);
    } else if (a.path) {
      const f = files.get(a.path) ?? { reads: 0, edits: 0, sessions: new Set() };
      if (a.kind === 'edit') f.edits += 1;
      else f.reads += 1;
      f.sessions.add(a.sessionId);
      files.set(a.path, f);
    }
  }

  const fileStats: FileStat[] = [...files.entries()]
    .map(([path, f]) => ({ path, reads: f.reads, edits: f.edits, sessions: f.sessions.size }))
    .sort((a, b) => b.sessions - a.sessions || b.reads + b.edits - (a.reads + a.edits) || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);

  const symbolStats: SymbolStat[] = [...symbols.entries()]
    .map(([term, s]) => ({ term, count: s.count, sessions: s.sessions.size }))
    .filter((s) => s.sessions >= MIN_SYMBOL_EVIDENCE || s.count >= MIN_SYMBOL_EVIDENCE)
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, MAX_SYMBOLS);

  return {
    files: fileStats,
    symbols: symbolStats,
    sessionsAnalyzed: allSessions.size,
    accessCount: accesses.length,
  };
}

// ---------------------------------------------------------------------------
// Distillation

export interface CodemapFile {
  path: string;
  /** One-line role for the file, grounded in its header/snippet. */
  role: string;
}

export interface CodemapResult {
  files: CodemapFile[];
  /** "Where things live" one-liners, e.g. symbol → file. */
  notes: string[];
}

export interface CodemapDistillOptions {
  /** path → first ~25 lines of the file, so roles are grounded not guessed. */
  snippets?: Record<string, string>;
  model?: string;
  /** Injectable for tests; defaults to the shared claude-CLI/API path. */
  runModel?: (prompt: string, model?: string) => Promise<string>;
}

export async function distillCodemap(
  signals: CodemapSignals,
  opts: CodemapDistillOptions = {},
): Promise<CodemapResult> {
  if (signals.files.length === 0) return { files: [], notes: [] };
  const call = opts.runModel ?? runModel;
  const raw = await call(buildCodemapPrompt(signals, opts.snippets ?? {}), opts.model);
  return parseCodemap(raw);
}

export function buildCodemapPrompt(signals: CodemapSignals, snippets: Record<string, string>): string {
  const fileLines = signals.files
    .map((f) => {
      const snippet = snippets[f.path] ? `\n    header:\n${indent(clip(snippets[f.path], 700))}` : '';
      return `  - ${f.path}  (touched in ${f.sessions} session(s): ${f.reads} read(s), ${f.edits} edit(s))${snippet}`;
    })
    .join('\n');
  const symbolLines = signals.symbols
    .map((s) => `  - "${s.term}"  (searched in ${s.sessions} session(s), ${s.count}×)`)
    .join('\n');

  return `You are documenting a codebase for AI coding agents. The data below is REAL evidence of what agents actually navigate in this repo: the files they read/edit most across sessions, and the symbols they repeatedly search for (i.e. "how does X work?"). Your job: write a concise architecture map so a future agent starts warm instead of re-deriving all this.

Rules:
- "files": for each genuinely load-bearing file, one imperative-free sentence saying what it does and what lives in it. Ground the role in the header shown — do NOT invent responsibilities not supported by the header or path. Keep only files that are actually architectural (skip lockfiles, generated files, one-off configs). Order by importance.
- "notes": 3-8 short "where things live" pointers, each ≤1 line. Prefer answering the searched symbols — e.g. a symbol → the file/function that defines it, or a key flow across files. These are the exact questions agents kept asking; answer them.
- Be specific and terse. This goes into CLAUDE.md; every line must earn its place.
- Respond with ONLY a JSON object (no markdown fence, no prose): {"files": [{"path": string, "role": string}], "notes": [string]}

## Most-navigated files
${fileLines || '  (none)'}

## Most-searched symbols (the "how does X work" questions)
${symbolLines || '  (none)'}`;
}

export function parseCodemap(raw: string): CodemapResult {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { files: [], notes: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { files: [], notes: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { files: [], notes: [] };
  const obj = parsed as { files?: unknown; notes?: unknown };
  const files: CodemapFile[] = Array.isArray(obj.files)
    ? obj.files
        .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
        .filter((f) => typeof f.path === 'string' && typeof f.role === 'string')
        .map((f) => ({ path: f.path as string, role: (f.role as string).trim() }))
    : [];
  const notes: string[] = Array.isArray(obj.notes)
    ? obj.notes.filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter(Boolean)
    : [];
  return { files, notes };
}

// ---------------------------------------------------------------------------
// Rendering + writing (own managed block, separate from the conventions block)

export function renderCodemapBlock(result: CodemapResult, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  const lines: string[] = [
    BEGIN,
    HEADING,
    `_Auto-generated from what agents actually navigate — last updated ${stamp}._`,
    '',
  ];
  if (result.files.length > 0) {
    lines.push('**Key files**', '');
    for (const f of result.files) lines.push(`- \`${f.path}\` — ${f.role}`);
    lines.push('');
  }
  if (result.notes.length > 0) {
    lines.push('**Where things live**', '');
    for (const n of result.notes) lines.push(`- ${n}`);
  }
  lines.push(END);
  return lines.join('\n');
}

/** Insert or replace the map block in a context file. Never touches other content. */
export async function applyCodemap(
  projectPath: string,
  target: 'CLAUDE.md' | 'AGENTS.md',
  result: CodemapResult,
  date = new Date(),
): Promise<{ path: string; created: boolean }> {
  const path = join(projectPath, target);
  let content = '';
  let created = false;
  if (existsSync(path)) {
    content = await readFile(path, 'utf8');
  } else {
    created = true;
    content = target === 'CLAUDE.md' ? '# Project context\n' : '# Agent guide\n';
  }
  const block = renderCodemapBlock(result, date);
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  let next: string;
  if (beginIdx >= 0 && endIdx > beginIdx) {
    next = content.slice(0, beginIdx) + block + content.slice(endIdx + END.length);
  } else {
    next = content.trimEnd() + '\n\n' + block + '\n';
  }
  await writeFile(path, next, 'utf8');
  return { path, created };
}

// ---------------------------------------------------------------------------
// End-to-end convenience (shared by the CLI and the MCP server)

export interface GeneratedCodemap {
  signals: CodemapSignals;
  result: CodemapResult;
}

/** Read the first `lines` lines of each path (its header), for grounding roles. */
export async function readHeaderSnippets(
  projectPath: string,
  paths: string[],
  lines = 25,
): Promise<Record<string, string>> {
  const snippets: Record<string, string> = {};
  for (const rel of paths) {
    try {
      snippets[rel] = (await readFile(join(projectPath, rel), 'utf8')).split('\n').slice(0, lines).join('\n');
    } catch {
      // file moved since the sessions — counts still carry the signal
    }
  }
  return snippets;
}

/**
 * Full pipeline: mine tool accesses → aggregate → ground in headers → distill.
 * Returns both the raw signals (for display/inspection) and the distilled map.
 */
export async function generateCodemap(
  projectPath: string,
  opts: { model?: string; runModel?: (prompt: string, model?: string) => Promise<string> } = {},
): Promise<GeneratedCodemap> {
  const signals = aggregateAccesses(await readToolAccesses(projectPath));
  if (signals.files.length === 0) return { signals, result: { files: [], notes: [] } };
  const snippets = await readHeaderSnippets(projectPath, signals.files.map((f) => f.path));
  const result = await distillCodemap(signals, { snippets, model: opts.model, runModel: opts.runModel });
  return { signals, result };
}

/** Does a context file already carry a codebase-map block? */
export function hasMapBlock(projectPath: string): boolean {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(projectPath, name);
    if (!existsSync(p)) continue;
    try {
      if (readFileSync(p, 'utf8').includes(BEGIN)) return true;
    } catch {
      // unreadable — treat as absent
    }
  }
  return false;
}

/**
 * Worth mapping = the agent has worked this repo across several sessions and
 * navigated a real spread of files. (Work spreads across files rather than
 * revisiting the same one, so total distinct files is a better signal than
 * per-file session counts.)
 */
const MAP_NUDGE_MIN_SESSIONS = 3;
const MAP_NUDGE_MIN_FILES = 8;

/**
 * Model-free check for the session-start nudge: is there enough agent
 * navigation in this project to be worth mapping, and no map yet? Reads only
 * this project's own sessions so it stays fast enough for a hook.
 */
export async function shouldSuggestMap(projectPath: string): Promise<{ suggest: boolean; files: number }> {
  if (hasMapBlock(projectPath)) return { suggest: false, files: 0 };
  const signals = aggregateAccesses(await readToolAccesses(projectPath, undefined, { ownSessionsOnly: true }));
  const suggest =
    signals.sessionsAnalyzed >= MAP_NUDGE_MIN_SESSIONS && signals.files.length >= MAP_NUDGE_MIN_FILES;
  return { suggest, files: signals.files.length };
}

function codemapCachePath(projectPath: string): string {
  return join(projectPath, '.ctxlayer', 'codemap.json');
}

/** Cache a generated map so a later apply step writes it without a second model call. */
export async function saveCodemapResult(projectPath: string, result: CodemapResult): Promise<string> {
  const path = codemapCachePath(projectPath);
  await mkdir(join(projectPath, '.ctxlayer'), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), result }, null, 2) + '\n', 'utf8');
  return path;
}

export async function loadCodemapResult(projectPath: string): Promise<CodemapResult | undefined> {
  try {
    const parsed = JSON.parse(await readFile(codemapCachePath(projectPath), 'utf8')) as { result?: CodemapResult };
    return parsed.result;
  } catch {
    return undefined;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
