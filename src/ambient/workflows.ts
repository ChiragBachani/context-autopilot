/**
 * Workflow mining: turn days of ambient activity records into Agent Operating
 * Procedure proposals.
 *
 * Pipeline: records → episodes (contiguous activity, split on 15-minute gaps)
 * → cross-day matching (episodes whose app/window step sequences look alike)
 * → distillation (the user's model writes the AOP: trigger + procedure +
 * evidence) → user approval → ~/.ctxlayer/aops/<slug>.json, which the live
 * observer watches for trigger matches.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runModel } from '../distill.js';
import type { AopEntry, AopTrigger, Proposal, ProposalFile } from '../types.js';
import { browserStepKey } from './browser.js';
import { ambientRoot, aopsRoot } from './config.js';
import type { ActivityRecord } from './records.js';

const EPISODE_GAP_MINUTES = 15;
const MIN_STEPS = 3;
const MATCH_THRESHOLD = 0.55;
const MAX_CANDIDATES = 8;
const MAX_TEXT_PER_STEP = 110;

// ---------------------------------------------------------------------------
// Episodes

export interface WorkflowStep {
  app: string;
  titleKey: string;
  /** Representative window title (untruncated, for display). */
  title: string;
  /** Active-tab URL, when the step was in a browser. */
  url?: string;
  /** Short OCR digest for the distiller. */
  textDigest?: string;
  timestamp: string;
}

export interface Episode {
  day: string;
  start: string;
  end: string;
  steps: WorkflowStep[];
}

/** Normalize a window title into a comparable key: drop numbers, keep 5 words. */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9]+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 5)
    .join(' ');
}

function stepKey(step: WorkflowStep): string {
  return `${step.app.toLowerCase()}::${step.titleKey}`;
}

/** Split a day's records into episodes and collapse consecutive same-context records. */
export function buildEpisodes(day: string, records: ActivityRecord[]): Episode[] {
  const episodes: Episode[] = [];
  let current: WorkflowStep[] = [];
  let start = '';
  let lastTs = 0;

  const flush = (end: string) => {
    if (current.length > 0) episodes.push({ day, start, end, steps: current });
    current = [];
  };

  for (const record of records) {
    const ts = Date.parse(record.timestamp);
    if (current.length > 0 && ts - lastTs > EPISODE_GAP_MINUTES * 60_000) {
      flush(new Date(lastTs).toISOString());
    }
    if (current.length === 0) start = record.timestamp;
    // For browser steps, cluster by host + first path segment (stable across
    // days) instead of the window title (which drifts with counts and subjects).
    const webKey = record.url ? browserStepKey(record.url) : '';
    const step: WorkflowStep = {
      app: record.app,
      titleKey: webKey || titleKey(record.windowTitle),
      title: record.windowTitle,
      url: record.url,
      textDigest: record.text?.replace(/\s+/g, ' ').slice(0, MAX_TEXT_PER_STEP),
      timestamp: record.timestamp,
    };
    const prev = current[current.length - 1];
    if (!prev || stepKey(prev) !== stepKey(step)) current.push(step);
    lastTs = ts;
  }
  flush(new Date(lastTs).toISOString());
  return episodes;
}

// ---------------------------------------------------------------------------
// Cross-day matching

/** Longest-common-subsequence ratio between two step sequences (0..1). */
export function sequenceSimilarity(a: WorkflowStep[], b: WorkflowStep[]): number {
  const ka = a.map(stepKey);
  const kb = b.map(stepKey);
  if (ka.length === 0 || kb.length === 0) return 0;
  const dp: number[][] = Array.from({ length: ka.length + 1 }, () => new Array<number>(kb.length + 1).fill(0));
  for (let i = 1; i <= ka.length; i++) {
    for (let j = 1; j <= kb.length; j++) {
      dp[i][j] = ka[i - 1] === kb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[ka.length][kb.length] / Math.max(ka.length, kb.length);
}

export interface WorkflowCandidate {
  id: string;
  episodes: Episode[];
  days: string[];
}

/**
 * Group episodes whose step sequences recur across at least two distinct
 * days — the definition of "you keep doing this".
 */
export function findWorkflowCandidates(episodesByDay: Map<string, Episode[]>): WorkflowCandidate[] {
  const all = [...episodesByDay.values()].flat().filter((e) => e.steps.length >= MIN_STEPS);
  const groups: Episode[][] = [];
  for (const episode of all) {
    let placed = false;
    for (const group of groups) {
      if (sequenceSimilarity(episode.steps, group[0].steps) >= MATCH_THRESHOLD) {
        group.push(episode);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([episode]);
  }
  const candidates: WorkflowCandidate[] = [];
  for (const group of groups) {
    const days = [...new Set(group.map((e) => e.day))].sort();
    if (days.length < 2) continue;
    candidates.push({ id: `wf-${candidates.length}`, episodes: group, days });
  }
  candidates.sort((a, b) => b.days.length - a.days.length || b.episodes.length - a.episodes.length);
  return candidates.slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Distillation

export interface WorkflowDistillOptions {
  model?: string;
  /** Injectable for tests; defaults to the shared claude-CLI/API path. */
  runModel?: (prompt: string, model?: string) => Promise<string>;
}

export async function distillWorkflows(
  candidates: WorkflowCandidate[],
  opts: WorkflowDistillOptions = {},
): Promise<Proposal[]> {
  if (candidates.length === 0) return [];
  const call = opts.runModel ?? runModel;
  const raw = await call(buildWorkflowPrompt(candidates), opts.model);
  const rejected = new Set(loadAmbientState().rejectedTitles.map((t) => t.toLowerCase()));
  return parseWorkflowEntries(raw)
    .filter((entry) => !rejected.has(entry.title.toLowerCase()))
    .map((entry) => ({ entry, targets: [], status: 'pending' as const }));
}

function buildWorkflowPrompt(candidates: WorkflowCandidate[]): string {
  const blocks = candidates
    .map((candidate, i) => {
      const episodes = candidate.episodes
        .slice(0, 4)
        .map((episode) => {
          const steps = episode.steps
            .map((s, n) => {
              const digest = s.textDigest ? ` — screen text: "${s.textDigest}"` : '';
              const where = s.url ? ` <${s.url}>` : '';
              return `    ${n + 1}. [${s.app}]${where} "${s.title}"${digest}`;
            })
            .join('\n');
          return `  Episode on ${episode.day} (${episode.start.slice(11, 16)}–${episode.end.slice(11, 16)}):\n${steps}`;
        })
        .join('\n');
      return `### Candidate ${i + 1} — recurred on ${candidate.days.length} day(s): ${candidate.days.join(', ')}\n${episodes}`;
    })
    .join('\n\n');

  return `You are analyzing ambient screen observations of a person working on their computer. Each candidate below is a sequence of app/window steps that recurred across multiple days — likely a repeated manual workflow that an AI agent could take over.

Your job: for each candidate that is genuinely a coherent, repeated workflow (not just random browsing), write an Agent Operating Procedure.

Rules:
- "title": short human name for the workflow (e.g. "Weekly metrics report").
- "rule": one sentence describing when/what (imperative).
- "procedure": 3-8 imperative steps AN AI AGENT would follow to do this work (not a description of what the human did — instructions for doing it). Be concrete: name the apps, files, URLs (use the <…> addresses shown), and actions visible in the evidence.
- "trigger": {"app": <app name exactly as it appears in the steps>, "titlePattern": <short distinctive window-title fragment>, "urlPattern": <host or host/path of the FIRST step, if it is a web page — e.g. "mail.google.com">} — the moment the workflow STARTS, so a live observer can offer to take over when the person begins it. Prefer urlPattern for web workflows; it is far more precise than a title.
- "confidence": "high" if the same sequence appears on 3+ days, "medium" for 2 days, "low" if the pattern is fuzzy.
- "rationale": one sentence on why this looks automatable.
- "evidence": one entry per episode: {"quote": "<day HH:MM–HH:MM: app → app → app>", "timestamp": <episode start ISO>, "sessionId": <day>}.
- Skip candidates that are not really workflows (respond with fewer objects, or [] if none qualify).
- Respond with ONLY a JSON array (no markdown fence, no prose).

## Observed candidates

${blocks}`;
}

/** Lenient parse: first JSON array, validating workflow fields. */
export function parseWorkflowEntries(raw: string): AopEntry[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: AopEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.title !== 'string' || !Array.isArray(e.procedure)) continue;
    const trigger = e.trigger as Record<string, unknown> | undefined;
    entries.push({
      title: e.title,
      rule: typeof e.rule === 'string' ? e.rule : '',
      rationale: typeof e.rationale === 'string' ? e.rationale : '',
      confidence:
        e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low' ? e.confidence : 'medium',
      procedure: e.procedure.filter((s): s is string => typeof s === 'string'),
      trigger:
        trigger && typeof trigger.app === 'string'
          ? {
              app: trigger.app,
              titlePattern: typeof trigger.titlePattern === 'string' ? trigger.titlePattern : undefined,
              urlPattern: typeof trigger.urlPattern === 'string' ? trigger.urlPattern : undefined,
            }
          : undefined,
      evidence: Array.isArray(e.evidence)
        ? e.evidence
            .filter((ev): ev is Record<string, string> => !!ev && typeof ev === 'object')
            .map((ev) => ({
              quote: String(ev.quote ?? ''),
              timestamp: String(ev.timestamp ?? ''),
              sessionId: String(ev.sessionId ?? ''),
            }))
        : [],
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Proposal store (ambient scope — separate from per-project context proposals)

function proposalsPath(): string {
  return join(ambientRoot(), 'proposals.json');
}

export function saveWorkflowProposals(proposals: Proposal[]): string {
  const file: ProposalFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectPath: ambientRoot(),
    source: 'screen',
    proposals,
  };
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(proposalsPath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
  return proposalsPath();
}

export function loadWorkflowProposals(): ProposalFile | undefined {
  try {
    return JSON.parse(readFileSync(proposalsPath(), 'utf8')) as ProposalFile;
  } catch {
    return undefined;
  }
}

export interface WorkflowDecisionResult {
  accepted: string[];
  rejected: string[];
  unmatched: string[];
  aopPaths: string[];
  stillPending: number;
}

/** Apply the user's explicit accept/reject decisions on workflow proposals. */
export function applyWorkflowDecisions(acceptTitles: string[], rejectTitles: string[] = []): WorkflowDecisionResult {
  const file = loadWorkflowProposals();
  if (!file || file.proposals.length === 0) {
    throw new Error(`No workflow proposals found at ${proposalsPath()}. Run a screen distill first.`);
  }
  const norm = (s: string) => s.trim().toLowerCase();
  const acceptSet = new Set(acceptTitles.map(norm));
  const rejectSet = new Set(rejectTitles.map(norm));
  const matched = new Set<string>();
  const accepted: string[] = [];
  const rejected: string[] = [];
  const aopPaths: string[] = [];
  const state = loadAmbientState();

  for (const proposal of file.proposals) {
    if (proposal.status !== 'pending') continue;
    const title = norm(proposal.entry.title);
    if (acceptSet.has(title)) {
      proposal.status = 'accepted';
      accepted.push(proposal.entry.title);
      matched.add(title);
      aopPaths.push(saveAop(proposal.entry));
    } else if (rejectSet.has(title)) {
      proposal.status = 'rejected';
      rejected.push(proposal.entry.title);
      matched.add(title);
      if (!state.rejectedTitles.some((t) => norm(t) === title)) state.rejectedTitles.push(proposal.entry.title);
    }
  }
  const unmatched = [...acceptSet, ...rejectSet].filter((t) => !matched.has(t));
  writeFileSync(proposalsPath(), JSON.stringify(file, null, 2) + '\n', 'utf8');
  saveAmbientState(state);
  return {
    accepted,
    rejected,
    unmatched,
    aopPaths,
    stillPending: file.proposals.filter((p) => p.status === 'pending').length,
  };
}

// ---------------------------------------------------------------------------
// AOP store

export interface StoredAop {
  format: 'aop/v1';
  slug: string;
  title: string;
  rule: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  procedure: string[];
  trigger?: AopTrigger;
  evidence: { quote: string; timestamp: string; sessionId: string }[];
  enabled: boolean;
  createdAt: string;
  source: 'screen';
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'aop'
  );
}

export function saveAop(entry: AopEntry): string {
  const aop: StoredAop = {
    format: 'aop/v1',
    slug: slugify(entry.title),
    title: entry.title,
    rule: entry.rule,
    rationale: entry.rationale,
    confidence: entry.confidence,
    procedure: entry.procedure ?? [],
    trigger: entry.trigger,
    evidence: entry.evidence,
    enabled: true,
    createdAt: new Date().toISOString(),
    source: 'screen',
  };
  mkdirSync(aopsRoot(), { recursive: true });
  const path = join(aopsRoot(), `${aop.slug}.json`);
  writeFileSync(path, JSON.stringify(aop, null, 2) + '\n', 'utf8');
  writeFileSync(join(aopsRoot(), `${aop.slug}.md`), renderAopMarkdown(aop), 'utf8');
  return path;
}

export function loadAops(): StoredAop[] {
  const root = aopsRoot();
  if (!existsSync(root)) return [];
  const aops: StoredAop[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    try {
      const aop = JSON.parse(readFileSync(join(root, name), 'utf8')) as StoredAop;
      if (aop.format === 'aop/v1') aops.push(aop);
    } catch {
      continue;
    }
  }
  aops.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return aops;
}

export function setAopEnabled(slug: string, enabled: boolean): StoredAop | undefined {
  const path = join(aopsRoot(), `${slug}.json`);
  if (!existsSync(path)) return undefined;
  const aop = JSON.parse(readFileSync(path, 'utf8')) as StoredAop;
  aop.enabled = enabled;
  writeFileSync(path, JSON.stringify(aop, null, 2) + '\n', 'utf8');
  return aop;
}

/** The prompt an agent receives when the user says "Run it". */
export function renderAopMarkdown(aop: StoredAop): string {
  const steps = aop.procedure.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const startAt = aop.trigger?.urlPattern ? `\nStart at: https://${aop.trigger.urlPattern.replace(/^https?:\/\//, '')}\n` : '';
  return `# Agent Operating Procedure: ${aop.title}

${aop.rule}
${startAt}
You are performing this workflow on behalf of the user — it was learned from
ambient observation of how they do it themselves, and they explicitly asked
you to take over. Follow the steps; ask before anything irreversible
(sending email, deleting data). If a step needs browser access you don't
have, say so and tell the user what to connect (the Chrome extension for
claude.ai lets you drive their browser).

## Procedure

${steps}
`;
}

// ---------------------------------------------------------------------------
// Ambient state (rejected proposals, live-trigger throttles)

export interface AmbientState {
  version: 1;
  /** Proposal titles the user rejected — never re-proposed. */
  rejectedTitles: string[];
  /** AOP slugs the user said "don't ask again" for (live trigger stays quiet). */
  dontAskSlugs: string[];
  /** slug → ISO timestamp of the last live-trigger prompt. */
  lastPrompted: Record<string, string>;
}

function statePath(): string {
  return join(ambientRoot(), 'state.json');
}

export function loadAmbientState(): AmbientState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<AmbientState>;
    return {
      version: 1,
      rejectedTitles: raw.rejectedTitles ?? [],
      dontAskSlugs: raw.dontAskSlugs ?? [],
      lastPrompted: raw.lastPrompted ?? {},
    };
  } catch {
    return { version: 1, rejectedTitles: [], dontAskSlugs: [], lastPrompted: {} };
  }
}

export function saveAmbientState(state: AmbientState): void {
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
