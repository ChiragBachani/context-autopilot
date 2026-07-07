/**
 * Proposal management: persist proposals to .ctxlayer/proposals.json, apply
 * accepted ones into a managed block inside CLAUDE.md / AGENTS.md.
 *
 * The managed block is delimited by markers so re-runs update it idempotently
 * and never touch hand-written content:
 *
 *   <!-- ctxlayer:begin -->
 *   ## Learned conventions (Context Autopilot)
 *   - **Title** — rule
 *   <!-- ctxlayer:end -->
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AopEntry, Proposal, ProposalFile, ProposalTarget } from './types.js';

const BEGIN = '<!-- ctxlayer:begin -->';
const END = '<!-- ctxlayer:end -->';
const HEADING = '## Learned conventions (Context Autopilot)';

export function proposalsPath(projectPath: string): string {
  return join(projectPath, '.ctxlayer', 'proposals.json');
}

export async function saveProposals(file: ProposalFile): Promise<string> {
  const path = proposalsPath(file.projectPath);
  await mkdir(join(file.projectPath, '.ctxlayer'), { recursive: true });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
  return path;
}

export async function loadProposals(projectPath: string): Promise<ProposalFile | undefined> {
  try {
    return JSON.parse(await readFile(proposalsPath(projectPath), 'utf8')) as ProposalFile;
  } catch {
    return undefined;
  }
}

/** Read whichever context files exist, for dedupe during distillation. */
export async function readExistingContext(projectPath: string): Promise<string> {
  const parts: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(projectPath, name);
    if (existsSync(p)) {
      parts.push(`--- ${name} ---\n${await readFile(p, 'utf8')}`);
    }
  }
  return parts.join('\n\n');
}

function renderEntry(entry: AopEntry): string {
  return `- **${entry.title}** — ${entry.rule}`;
}

function renderBlock(entries: AopEntry[]): string {
  return [BEGIN, HEADING, '', ...entries.map(renderEntry), END].join('\n');
}

/**
 * Apply accepted entries to a context file, creating or replacing the
 * managed block. Returns the entries now present in the block.
 */
export async function applyToFile(
  projectPath: string,
  target: ProposalTarget,
  accepted: AopEntry[],
): Promise<{ path: string; created: boolean; total: number }> {
  const path = join(projectPath, target);
  let content = '';
  let created = false;
  if (existsSync(path)) {
    content = await readFile(path, 'utf8');
  } else {
    created = true;
    content = target === 'CLAUDE.md' ? '# Project context\n' : '# Agent guide\n';
  }

  const existing = parseManagedEntries(content);
  const merged = mergeEntries(existing, accepted);
  const block = renderBlock(merged);

  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  let next: string;
  if (beginIdx >= 0 && endIdx > beginIdx) {
    next = content.slice(0, beginIdx) + block + content.slice(endIdx + END.length);
  } else {
    next = content.trimEnd() + '\n\n' + block + '\n';
  }
  await writeFile(path, next, 'utf8');
  return { path, created, total: merged.length };
}

/** Recover entries already inside the managed block (title + rule only). */
function parseManagedEntries(content: string): AopEntry[] {
  const beginIdx = content.indexOf(BEGIN);
  const endIdx = content.indexOf(END);
  if (beginIdx < 0 || endIdx <= beginIdx) return [];
  const block = content.slice(beginIdx, endIdx);
  const entries: AopEntry[] = [];
  for (const line of block.split('\n')) {
    const m = /^- \*\*(.+?)\*\* — (.*)$/.exec(line.trim());
    if (m) {
      entries.push({ title: m[1], rule: m[2], rationale: '', confidence: 'high', evidence: [] });
    }
  }
  return entries;
}

function mergeEntries(existing: AopEntry[], incoming: AopEntry[]): AopEntry[] {
  const merged = [...existing];
  for (const entry of incoming) {
    const i = merged.findIndex((e) => e.title.toLowerCase() === entry.title.toLowerCase());
    if (i >= 0) merged[i] = entry;
    else merged.push(entry);
  }
  return merged;
}

export function renderProposalPreview(proposal: Proposal, index: number, total: number): string {
  const { entry } = proposal;
  const evidence = entry.evidence
    .slice(0, 3)
    .map((ev) => `      · ${ev.timestamp ? ev.timestamp.slice(0, 10) + ' — ' : ''}"${ev.quote.slice(0, 120)}${ev.quote.length > 120 ? '…' : ''}"`)
    .join('\n');
  return [
    `\n[${index + 1}/${total}] ${entry.title}  (confidence: ${entry.confidence})`,
    `    + ${renderEntry(entry)}`,
    entry.rationale ? `    why: ${entry.rationale}` : '',
    evidence ? `    evidence:\n${evidence}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
