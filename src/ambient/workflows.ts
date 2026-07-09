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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runModel } from '../distill.js';
import type { AopEntry, AopTimeWindow, AopTrigger, Proposal, ProposalFile } from '../types.js';
import { browserStepKey } from './browser.js';
import { ambientRoot, aopsRoot } from './config.js';
import { listDays, readDay, readDaySegments, type ActivityRecord } from './records.js';

const EPISODE_GAP_MINUTES = 15;
const MIN_STEPS = 3;
const MATCH_THRESHOLD = 0.55;
const MAX_CANDIDATES = 8;
const MAX_TEXT_PER_STEP = 110;

// ---------------------------------------------------------------------------
// Moments — the miner's single source of truth
//
// Two observation streams exist: dense activity segments (every stretch of
// work: app/title/url, no OCR) and sparse screenshot records (rich OCR text,
// only at intentional moments). Mining from records alone made the Patterns
// tab blind to most of the day. A "moment" merges both: one chronological
// stream with full coverage from segments and OCR text attached from the
// record captured inside the same app/title context. Either file may be
// missing (demo fixtures are records-only; a fresh install is segments-heavy).

/** Merge one day's segments + screenshot records into a chronological stream. */
export function buildDayMoments(day: string): ActivityRecord[] {
  const segments = readDaySegments(day);
  const records = readDay(day);
  if (segments.length === 0) return records; // records-only day (e.g. demo)

  // OCR text lookup: record → the segment covering the same app/title/time.
  const unmatched: ActivityRecord[] = [];
  const textFor = new Map<number, string>(); // segment index → OCR text
  for (const record of records) {
    if (!record.text) continue;
    const at = Date.parse(record.timestamp);
    const i = segments.findIndex(
      (s) =>
        s.app === record.app &&
        s.windowTitle === record.windowTitle &&
        at >= Date.parse(s.start) - 2000 &&
        at <= Date.parse(s.end) + 2000,
    );
    if (i >= 0) {
      // Keep the longest OCR extract seen inside the segment.
      if ((textFor.get(i)?.length ?? 0) < record.text.length) textFor.set(i, record.text);
    } else {
      unmatched.push(record); // capture outside any segment — keep as its own moment
    }
  }

  const moments: ActivityRecord[] = segments.map((s, i) => ({
    id: `seg-${day}-${i}`,
    timestamp: s.start,
    app: s.app,
    windowTitle: s.windowTitle,
    trigger: 'dwell',
    url: s.url,
    text: textFor.get(i),
  }));
  moments.push(...unmatched);
  moments.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return moments;
}

/** Every observed day → merged moments. What ALL mining paths consume. */
export function allDayMoments(): Map<string, ActivityRecord[]> {
  const byDay = new Map<string, ActivityRecord[]>();
  for (const day of listDays()) byDay.set(day, buildDayMoments(day));
  return byDay;
}

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

/** Longest-common-subsequence ratio between two key sequences (0..1). */
export function keySequenceSimilarity(ka: string[], kb: string[]): number {
  if (ka.length === 0 || kb.length === 0) return 0;
  const dp: number[][] = Array.from({ length: ka.length + 1 }, () => new Array<number>(kb.length + 1).fill(0));
  for (let i = 1; i <= ka.length; i++) {
    for (let j = 1; j <= kb.length; j++) {
      dp[i][j] = ka[i - 1] === kb[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[ka.length][kb.length] / Math.max(ka.length, kb.length);
}

/** Longest-common-subsequence ratio between two step sequences (0..1). */
export function sequenceSimilarity(a: WorkflowStep[], b: WorkflowStep[]): number {
  return keySequenceSimilarity(a.map(stepKey), b.map(stepKey));
}

/** The step-key signature of a candidate (its representative episode). */
export function candidateSignature(candidate: WorkflowCandidate): string[] {
  return candidate.episodes[0].steps.map(stepKey);
}

export interface WorkflowCandidate {
  id: string;
  episodes: Episode[];
  days: string[];
}

/**
 * Group episodes whose step sequences recur — across days, or twice within
 * the same day. "You keep doing this" shouldn't have to wait for tomorrow:
 * same-day repetition surfaces on day one (the distiller rates cross-day
 * recurrence as higher confidence).
 */
export function findWorkflowCandidates(
  episodesByDay: Map<string, Episode[]>,
  dismissed: string[][] = loadAmbientState().dismissedSignatures,
): WorkflowCandidate[] {
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
    if (days.length < 2 && group.length < 2) continue; // a single occurrence is never a pattern
    // "Not a pattern" teaches: skip groups that look like something the user
    // already dismissed (not just exact-title matches — lookalikes too).
    const sig = group[0].steps.map(stepKey);
    if (dismissed.some((d) => keySequenceSimilarity(sig, d) >= MATCH_THRESHOLD)) continue;
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
    .map((entry) => ({
      entry,
      targets: [],
      status: 'pending' as const,
      // Carry the source candidate's signature so a rejection can suppress
      // lookalikes later. Best-match by trigger-app overlap, else the first.
      signature: candidateSignature(bestCandidateFor(entry, candidates)),
    }));
}

/** Pick the candidate an entry most likely came from (trigger app in its steps). */
function bestCandidateFor(entry: AopEntry, candidates: WorkflowCandidate[]): WorkflowCandidate {
  const app = entry.trigger?.app?.toLowerCase();
  if (app) {
    const hit = candidates.find((c) => c.episodes[0].steps.some((s) => s.app.toLowerCase().includes(app)));
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Distill ONE episode into an AOP entry — the "⚡ Automate this" path. The
 * user explicitly chose this occurrence, so the distiller must not skip it as
 * "not a real workflow"; recurrence is not required.
 */
export async function distillSingleEpisode(
  episode: Episode,
  opts: WorkflowDistillOptions = {},
): Promise<AopEntry | undefined> {
  const call = opts.runModel ?? runModel;
  const candidate: WorkflowCandidate = { id: 'manual', episodes: [episode], days: [episode.day] };
  const prompt =
    buildWorkflowPrompt([candidate]) +
    `\n\nIMPORTANT OVERRIDE: the user explicitly clicked "Automate this" on this exact episode. Do NOT skip it or return [] — write the best possible AOP for it even though it has only been seen once. Confidence should be "medium" (user-confirmed intent).`;
  const raw = await call(prompt, opts.model);
  return parseWorkflowEntries(raw)[0];
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
      return `### Candidate ${i + 1} — occurred ${candidate.episodes.length} time(s) across ${candidate.days.length} day(s): ${candidate.days.join(', ')}\n${episodes}`;
    })
    .join('\n\n');

  return `You are analyzing ambient screen observations of a person working on their computer. Each candidate below is a sequence of app/window steps that recurred across multiple days — likely a repeated manual workflow that an AI agent could take over.

Your job: for each candidate that is genuinely a coherent, repeated workflow (not just random browsing), write an Agent Operating Procedure.

Rules:
- "title": short human name for the workflow (e.g. "Weekly metrics report").
- "rule": one sentence describing when/what (imperative).
- "procedure": 3-8 imperative steps AN AI AGENT would follow to do this work (not a description of what the human did — instructions for doing it). Be concrete: name the apps, files, URLs (use the <…> addresses shown), and actions visible in the evidence.
- "trigger": {"app": <app name exactly as it appears in the steps>, "titlePattern": <short distinctive window-title fragment>, "urlPattern": <host or host/path of the FIRST step, if it is a web page — e.g. "mail.google.com">, "timeWindow": {"weekdays": [<0=Sun…6=Sat of the days the episodes occurred>], "startHour": <local hour, ~90min before the typical start>, "endHour": <local hour, ~90min after>}} — the moment the workflow STARTS. Include timeWindow ONLY if the episodes clearly cluster in time (e.g. all weekday mornings); omit it when they're scattered. Prefer urlPattern for web workflows; it is far more precise than a title.
- "confidence": "high" if the same sequence appears on 3+ days, "medium" for 2 days, "low" if it only recurred within a single day or the pattern is fuzzy.
- "rationale": one sentence on why this looks automatable.
- "evidence": one entry per episode: {"quote": "<day HH:MM–HH:MM: app → app → app>", "timestamp": <episode start ISO>, "sessionId": <day>}.
- Skip candidates that are not really workflows (respond with fewer objects, or [] if none qualify).
- Respond with ONLY a JSON array (no markdown fence, no prose).

## Observed candidates

${blocks}`;
}

function parseTimeWindow(tw: unknown): AopTimeWindow | undefined {
  if (!tw || typeof tw !== 'object') return undefined;
  const w = tw as Record<string, unknown>;
  const startHour = Number(w.startHour);
  const endHour = Number(w.endHour);
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return undefined;
  const weekdays = Array.isArray(w.weekdays)
    ? w.weekdays.map(Number).filter((d) => d >= 0 && d <= 6)
    : undefined;
  return {
    weekdays: weekdays?.length ? [...new Set(weekdays)].sort() : undefined,
    startHour: Math.min(23, Math.max(0, Math.floor(startHour))),
    endHour: Math.min(24, Math.max(0, Math.floor(endHour))),
  };
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
              timeWindow: parseTimeWindow(trigger.timeWindow),
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
      // Teach the miner: remember the shape, so lookalikes stop resurfacing.
      const sig = proposal.signature;
      if (sig && sig.length && !state.dismissedSignatures.some((d) => d.join('|') === sig.join('|'))) {
        state.dismissedSignatures.push(sig);
      }
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
  /** 'screen' = mined from observation; 'manual' = hand-made in the dashboard. */
  source: 'screen' | 'manual';
  /** Run on a clock, no trigger needed (a LaunchAgent per scheduled AOP). */
  schedule?: AopSchedule;
}

export interface AopSchedule {
  /** 0 = Sunday … 6 = Saturday. Empty/omitted = every day. */
  weekdays?: number[];
  hour: number;
  minute: number;
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

export function saveAop(entry: AopEntry, source: StoredAop['source'] = 'screen'): string {
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
    source,
  };
  writeAop(aop);
  return join(aopsRoot(), `${aop.slug}.json`);
}

function writeAop(aop: StoredAop): void {
  mkdirSync(aopsRoot(), { recursive: true });
  writeFileSync(join(aopsRoot(), `${aop.slug}.json`), JSON.stringify(aop, null, 2) + '\n', 'utf8');
  writeFileSync(join(aopsRoot(), `${aop.slug}.md`), renderAopMarkdown(aop), 'utf8');
}

export interface AopPatch {
  title?: string;
  rule?: string;
  procedure?: string[];
  trigger?: AopTrigger | null; // null clears the live trigger
  schedule?: AopSchedule | null; // null clears the schedule
}

/**
 * Edit an existing automation in place. The slug stays stable (it's the live
 * trigger's identity in ambient state), so a renamed title keeps its history.
 * The rendered markdown — what an agent receives on "Run it" — is refreshed.
 */
export function updateAop(slug: string, patch: AopPatch): StoredAop | undefined {
  const path = join(aopsRoot(), `${slug}.json`);
  if (!existsSync(path)) return undefined;
  const aop = JSON.parse(readFileSync(path, 'utf8')) as StoredAop;
  if (typeof patch.title === 'string' && patch.title.trim()) aop.title = patch.title.trim();
  if (typeof patch.rule === 'string') aop.rule = patch.rule.trim();
  if (Array.isArray(patch.procedure)) {
    aop.procedure = patch.procedure.map((s) => String(s).trim()).filter(Boolean);
  }
  if (patch.trigger === null) aop.trigger = undefined;
  else if (patch.trigger && typeof patch.trigger.app === 'string' && patch.trigger.app.trim()) {
    aop.trigger = {
      app: patch.trigger.app.trim(),
      titlePattern: patch.trigger.titlePattern?.trim() || undefined,
      urlPattern: patch.trigger.urlPattern?.trim() || undefined,
    };
  }
  if (patch.schedule === null) aop.schedule = undefined;
  else if (patch.schedule) aop.schedule = normalizeSchedule(patch.schedule);
  writeAop(aop);
  return aop;
}

export function normalizeSchedule(s: AopSchedule): AopSchedule | undefined {
  const hour = Math.min(23, Math.max(0, Math.floor(Number(s.hour))));
  const minute = Math.min(59, Math.max(0, Math.floor(Number(s.minute))));
  if (Number.isNaN(hour) || Number.isNaN(minute)) return undefined;
  const weekdays = (s.weekdays ?? []).map(Number).filter((d) => d >= 0 && d <= 6);
  return { weekdays: weekdays.length ? [...new Set(weekdays)].sort() : undefined, hour, minute };
}

/** Remove an automation entirely (json + rendered markdown). */
export function deleteAop(slug: string): boolean {
  const path = join(aopsRoot(), `${slug}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  rmSync(join(aopsRoot(), `${slug}.md`), { force: true });
  return true;
}

/** Hand-make an automation from scratch (the "+ New automation" button). */
export function createAop(fields: {
  title: string;
  rule?: string;
  procedure: string[];
  trigger?: AopTrigger;
  schedule?: AopSchedule;
}): StoredAop {
  const entry: AopEntry = {
    title: fields.title.trim(),
    rule: fields.rule?.trim() ?? '',
    rationale: 'Created by hand in the dashboard.',
    confidence: 'high', // the user wrote it themselves
    procedure: fields.procedure.map((s) => s.trim()).filter(Boolean),
    trigger: fields.trigger?.app?.trim()
      ? {
          app: fields.trigger.app.trim(),
          titlePattern: fields.trigger.titlePattern?.trim() || undefined,
          urlPattern: fields.trigger.urlPattern?.trim() || undefined,
        }
      : undefined,
    evidence: [],
  };
  saveAop(entry, 'manual');
  const slug = slugify(entry.title);
  if (fields.schedule) updateAop(slug, { schedule: fields.schedule });
  return loadAops().find((a) => a.slug === slug)!;
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
  /** ISO timestamp of the last periodic auto-distill run. */
  lastAutoDistillAt?: string;
  /** Day (YYYY-MM-DD) the automatic recap notification last fired. */
  autoRecapDay?: string;
  /** Step-key sequences of dismissed candidates — suppress lookalikes. */
  dismissedSignatures: string[][];
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
      lastAutoDistillAt: raw.lastAutoDistillAt,
      autoRecapDay: raw.autoRecapDay,
      dismissedSignatures: raw.dismissedSignatures ?? [],
    };
  } catch {
    return { version: 1, rejectedTitles: [], dontAskSlugs: [], lastPrompted: {}, dismissedSignatures: [] };
  }
}

export function saveAmbientState(state: AmbientState): void {
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
}
