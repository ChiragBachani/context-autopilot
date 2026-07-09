/**
 * Claude Code source adapter.
 *
 * Reads session transcripts from ~/.claude/projects/<slug>/<session>.jsonl.
 * Each line is a JSON object; the ones we care about are `type: "user"`
 * entries, which are either real human prompts (origin.kind === "human" or
 * plain string content) or tool results (which reveal rejected tool calls).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Observation, ObservedProject, SourceAdapter } from '../types.js';
import { classifyCorrection, looksLikeHarnessBoilerplate, looksLikeInjectedContent } from '../extract.js';

const REJECTION_MARKER = "doesn't want to proceed";
const INTERRUPT_MARKER = '[Request interrupted by user';

interface TranscriptLine {
  type?: string;
  message?: { role?: string; content?: unknown };
  origin?: { kind?: string } | null;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  userType?: string;
}

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Join all text blocks of a content value into one string. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } =>
      !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function toolResultTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; content?: unknown };
    if (b.type !== 'tool_result') continue;
    if (typeof b.content === 'string') out.push(b.content);
    else out.push(textOf(b.content));
  }
  return out;
}

function isHumanEntry(line: TranscriptLine): boolean {
  if (line.isSidechain) return false;
  const origin = line.origin;
  if (origin && typeof origin === 'object') return origin.kind === 'human';
  // Older transcripts have no origin field; a plain-string user message from
  // an external userType is a human prompt.
  return typeof line.message?.content === 'string' && line.userType === 'external';
}

export class ClaudeCodeAdapter implements SourceAdapter {
  name = 'claude-code';

  constructor(private root: string = projectsRoot()) {}

  async discover(): Promise<ObservedProject[]> {
    let slugs: string[];
    try {
      slugs = await readdir(this.root);
    } catch {
      return [];
    }
    const projects: ObservedProject[] = [];
    for (const slug of slugs) {
      const dir = join(this.root, slug);
      let entries: string[];
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
        entries = await readdir(dir);
      } catch {
        continue;
      }
      const sessions = entries.filter((f) => f.endsWith('.jsonl'));
      if (sessions.length === 0) continue;
      let lastActivity: string | undefined;
      let path: string | undefined;
      // Peek at the newest session for the real cwd and last-activity time.
      try {
        const newest = await newestFile(dir, sessions);
        const s = await stat(join(dir, newest));
        lastActivity = s.mtime.toISOString();
        path = await firstCwd(join(dir, newest));
      } catch {
        // fall through with what we have
      }
      projects.push({ id: slug, path, sessionCount: sessions.length, lastActivity });
    }
    projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return projects;
  }

  async observe(project: ObservedProject): Promise<Observation[]> {
    const dir = join(this.root, project.id);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    const observations: Observation[] = [];
    // Resumed sessions copy their full history into a new transcript file, so
    // the same message can appear in several files. Dedupe on session + text.
    const seen = new Set<string>();
    for (const file of files) {
      for (const obs of await this.observeSession(join(dir, file))) {
        const key = `${obs.sessionId}:${obs.kind}:${obs.text.slice(0, 200)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        observations.push(obs);
      }
    }
    observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return observations;
  }

  private async observeSession(filePath: string): Promise<Observation[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return [];
    }
    const observations: Observation[] = [];
    /** Last assistant text seen, to give corrections/rejections context. */
    let lastAssistantText = '';
    /** Set when we see a user interruption; boosts the next human message. */
    let pendingInterrupt = false;
    let n = 0;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      n++;
      const ts = entry.timestamp ?? '';
      const sessionId = entry.sessionId ?? filePath;

      if (entry.type === 'assistant' && !entry.isSidechain) {
        const text = textOf(entry.message?.content);
        if (text.trim()) lastAssistantText = text.slice(0, 400);
        continue;
      }
      if (entry.type !== 'user') continue;

      const content = entry.message?.content;

      // Tool results: surface rejected tool calls.
      for (const resultText of toolResultTexts(content)) {
        if (!resultText.includes(REJECTION_MARKER)) continue;
        // The harness often appends the user's guidance after the rejection
        // boilerplate ("the user said: …" / "To tell you how to proceed…").
        let guidance = extractRejectionGuidance(resultText);
        if (guidance && looksLikeHarnessBoilerplate(guidance)) guidance = undefined;
        observations.push({
          id: `${sessionId}:${n}`,
          source: this.name,
          kind: 'rejection',
          timestamp: ts,
          sessionId,
          text: guidance ?? '(tool call rejected without guidance)',
          agentContext: lastAssistantText || undefined,
        });
      }

      if (!isHumanEntry(entry)) continue;
      const text = textOf(content).trim();
      if (!text || looksLikeInjectedContent(text)) continue;
      if (text.includes(INTERRUPT_MARKER)) {
        pendingInterrupt = true;
        continue;
      }

      const correction = classifyCorrection(text, {
        followsAgentActivity: lastAssistantText.length > 0,
        followsInterrupt: pendingInterrupt,
      });
      pendingInterrupt = false;

      observations.push({
        id: `${sessionId}:${n}`,
        source: this.name,
        kind: correction ? 'correction' : 'instruction',
        timestamp: ts,
        sessionId,
        text,
        agentContext: correction ? lastAssistantText || undefined : undefined,
      });
    }
    return observations;
  }
}

// ---------------------------------------------------------------------------
// Tool-access extraction (for the codebase map).
//
// The same transcripts that reveal what a human repeats also reveal what the
// *agent* keeps re-deriving: which files it reads, edits, and greps for before
// it can act. That navigation is the raw evidence for an architecture map — so
// the next session starts warm instead of cold-reading the codebase again.

/** One thing the agent did to the code: read/edit a file, or search for a term. */
export interface ToolAccess {
  kind: 'read' | 'edit' | 'search';
  /** Project-relative path (read/edit). */
  path?: string;
  /** Search pattern (search). */
  term?: string;
  timestamp: string;
  sessionId: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
/** Directories whose files are noise for an architecture map. */
const IGNORED_SEGMENTS = ['node_modules/', '/.git/', 'dist/', '/.ctxlayer/', 'build/', '.next/'];

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function toolUseBlocks(content: unknown): ToolUseBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is ToolUseBlock => !!b && typeof b === 'object' && (b as ToolUseBlock).type === 'tool_use',
  );
}

/** A search term worth keeping: a symbol-ish token, not a sprawling regex. */
function cleanSearchTerm(pattern: unknown): string | undefined {
  if (typeof pattern !== 'string') return undefined;
  const t = pattern.trim().replace(/^\^|\$$/g, '');
  // Keep identifier-like queries (function/type/var names); drop regexes with
  // spaces, alternation, or metacharacters — those aren't "how does X work".
  if (!/^[\w.$-]{3,60}$/.test(t)) return undefined;
  return t;
}

/**
 * Mine every tool access relevant to a project from ALL Claude Code
 * transcripts. File reads/edits are attributed by their absolute path — which
 * project the file physically lives in — so work done from a parent-directory
 * session still counts. Searches have no path, so they're attributed by the
 * session's working directory. Cross-session frequency is what makes a file
 * "load-bearing" — the raw material the codebase-map distiller aggregates.
 */
export async function readToolAccesses(
  projectPath: string,
  root: string = projectsRoot(),
  opts: { ownSessionsOnly?: boolean } = {},
): Promise<ToolAccess[]> {
  const wanted = resolve(projectPath);
  const adapter = new ClaudeCodeAdapter(root);
  let projects = await adapter.discover();
  // Fast path (e.g. the session-start nudge): only this project's own
  // sessions, skipping the cross-project transcript scan.
  if (opts.ownSessionsOnly) {
    projects = projects.filter((p) => p.path && resolve(p.path) === wanted);
  }
  const accesses: ToolAccess[] = [];
  const seen = new Set<string>();

  const relInProject = (fp: unknown): string | undefined => {
    if (typeof fp !== 'string' || !fp) return undefined;
    const abs = resolve(fp);
    if (abs !== wanted && !abs.startsWith(wanted + '/')) return undefined; // outside project
    const rel = relative(wanted, abs);
    if (IGNORED_SEGMENTS.some((seg) => `/${rel}`.includes(seg))) return undefined;
    return rel;
  };

  for (const project of projects) {
    // Searches (no path) only count when this session's cwd IS the project.
    const sessionInProject = !!project.path && resolve(project.path) === wanted;
    const dir = join(root, project.id);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      let raw: string;
      try {
        raw = await readFile(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let entry: TranscriptLine;
        try {
          entry = JSON.parse(line) as TranscriptLine;
        } catch {
          continue;
        }
        if (entry.type !== 'assistant' || entry.isSidechain) continue;
        const ts = entry.timestamp ?? '';
        const sessionId = entry.sessionId ?? file;
        for (const block of toolUseBlocks(entry.message?.content)) {
          const access = toAccess(block, ts, sessionId, relInProject, sessionInProject);
          if (!access) continue;
          // Resumed sessions replay history into new files — dedupe on the
          // session, not the file, so counts reflect distinct work.
          const key = `${access.sessionId}:${access.kind}:${access.path ?? access.term}:${ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          accesses.push(access);
        }
      }
    }
  }
  return accesses;
}

function toAccess(
  block: ToolUseBlock,
  timestamp: string,
  sessionId: string,
  relInProject: (fp: unknown) => string | undefined,
  sessionInProject: boolean,
): ToolAccess | undefined {
  const name = block.name ?? '';
  const input = block.input ?? {};
  if (READ_TOOLS.has(name)) {
    const path = relInProject(input.file_path);
    return path ? { kind: 'read', path, timestamp, sessionId } : undefined;
  }
  if (EDIT_TOOLS.has(name)) {
    const path = relInProject((input as { file_path?: unknown; notebook_path?: unknown }).file_path ?? input.notebook_path);
    return path ? { kind: 'edit', path, timestamp, sessionId } : undefined;
  }
  if (SEARCH_TOOLS.has(name) && sessionInProject) {
    const term = cleanSearchTerm(input.pattern);
    return term ? { kind: 'search', term, timestamp, sessionId } : undefined;
  }
  return undefined;
}

function extractRejectionGuidance(resultText: string): string | undefined {
  const markers = ['the user said:', 'user said:'];
  const lower = resultText.toLowerCase();
  for (const m of markers) {
    const i = lower.indexOf(m);
    if (i >= 0) {
      const guidance = resultText.slice(i + m.length).trim();
      if (guidance) return guidance;
    }
  }
  return undefined;
}

async function newestFile(dir: string, files: string[]): Promise<string> {
  let best = files[0];
  let bestM = 0;
  for (const f of files) {
    const s = await stat(join(dir, f));
    if (s.mtimeMs > bestM) {
      bestM = s.mtimeMs;
      best = f;
    }
  }
  return best;
}

/** Read the first entry that has a cwd, without parsing the whole file. */
async function firstCwd(filePath: string): Promise<string | undefined> {
  const raw = await readFile(filePath, 'utf8');
  for (const line of raw.split('\n').slice(0, 50)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TranscriptLine;
      if (entry.cwd) return entry.cwd;
    } catch {
      continue;
    }
  }
  return undefined;
}
