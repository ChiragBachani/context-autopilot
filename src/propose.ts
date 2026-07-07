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

export interface DecisionResult {
  accepted: string[];
  rejected: string[];
  /** Titles the caller sent that matched no pending proposal. */
  unmatched: string[];
  applied: { target: ProposalTarget; path: string; created: boolean; total: number }[];
  stillPending: number;
}

/**
 * Apply explicit user decisions to pending proposals by title. Accepted
 * entries are written to their target context files; rejected ones are
 * remembered (and never re-proposed); everything else stays pending.
 */
export async function applyDecisions(
  rootPath: string,
  acceptTitles: string[],
  rejectTitles: string[] = [],
): Promise<DecisionResult> {
  const file = await loadProposals(rootPath);
  if (!file || file.proposals.length === 0) {
    throw new Error(`No proposals found at ${proposalsPath(rootPath)}. Run distill first.`);
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const acceptSet = new Set(acceptTitles.map(norm));
  const rejectSet = new Set(rejectTitles.map(norm));
  const matched = new Set<string>();
  const accepted: Proposal[] = [];
  const rejected: string[] = [];
  for (const proposal of file.proposals) {
    if (proposal.status !== 'pending') continue;
    const title = norm(proposal.entry.title);
    if (acceptSet.has(title)) {
      proposal.status = 'accepted';
      accepted.push(proposal);
      matched.add(title);
    } else if (rejectSet.has(title)) {
      proposal.status = 'rejected';
      rejected.push(proposal.entry.title);
      matched.add(title);
    }
  }
  const unmatched = [...acceptSet, ...rejectSet].filter((t) => !matched.has(t));
  await saveProposals(file);

  const applied: DecisionResult['applied'] = [];
  const targets = new Set<ProposalTarget>();
  for (const p of accepted) for (const t of p.targets) targets.add(t);
  for (const target of targets) {
    const entries = accepted.filter((p) => p.targets.includes(target)).map((p) => p.entry);
    applied.push({ target, ...(await applyToFile(rootPath, target, entries)) });
  }
  return {
    accepted: accepted.map((p) => p.entry.title),
    rejected,
    unmatched,
    applied,
    stillPending: file.proposals.filter((p) => p.status === 'pending').length,
  };
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
