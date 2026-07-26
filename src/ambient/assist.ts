/**
 * Live Assist — turn a detected situation into a concrete offer of help.
 *
 * One grounded model call, present tense ("what are they trying to do RIGHT
 * NOW and what could I do about it"), unlike ask.ts which is retrospective
 * ("what were they trying to do and did they finish"). The prompt is biased
 * hard toward returning nothing: the failure mode that kills an ambient tool
 * is not missing an offer, it's a stream of useless ones.
 */

import { buildDayEvidence } from './summarize.js';
import { renderProbeFacts, type ProbeFact } from './probes.js';
import { SAFETY_BRIEF } from './safety.js';
import type { Situation } from './situations.js';
import type { ActivityRecord, ActivitySegment } from './records.js';
import type { AskHandoff } from './ask.js';
import { runModel } from '../distill.js';

/** Evidence is small by construction (a 5-minute window), but cap it anyway. */
const EVIDENCE_CAP = 6_000;

export interface AssistProposal {
  /** What the user appears to be trying to accomplish. */
  goal: string;
  /** The offer, as one sentence shown in the notification. */
  offer: string;
  confidence: 'high' | 'medium' | 'low';
  /** Stable key for goal-level dedupe (so one goal is offered once). */
  goalKey: string;
  handoff: AskHandoff;
}

export interface AssistOptions {
  model?: string;
  /** Injectable for tests, matching the AskOptions/NarrateOptions convention. */
  runModel?: (prompt: string, model?: string) => Promise<string>;
}

export interface AssistInput {
  situations: Situation[];
  records: ActivityRecord[];
  segments: ActivitySegment[];
  probes: ProbeFact[];
}

export function buildAssistProposalPrompt(input: AssistInput): string {
  const evidence = buildDayEvidence(input.segments, input.records).slice(0, EVIDENCE_CAP);
  const signals = input.situations.map((s) => `- [${s.kind}] ${s.detail}`).join('\n');
  return `You are watching a developer work, live, through an ambient activity observer. Your job is to decide whether an AI agent could genuinely help them RIGHT NOW, mid-task.

## Signals detected in the last few minutes
${signals || '(none)'}

## What they were doing (activity trail, most recent last)
${evidence || '(no activity captured)'}

## Facts probed from their machine just now
${renderProbeFacts(input.probes)}

## Your task
Infer what they are TRYING TO ACCOMPLISH (not which apps they used), then decide whether an agent could take a concrete piece of that work off their hands right now.

Reply with ONE JSON object and nothing else:
{"goal": "<what they're trying to accomplish, plain language>",
 "offer": "<ONE sentence, addressed to them, naming the specific thing you'd do. Reference a probed fact when it makes the offer concrete.>",
 "confidence": "high" | "medium" | "low",
 "handoff": {"goal": "<short imperative goal for the agent>", "context": "<what they've tried, what you observed, specific paths/apps/numbers the agent will need>"}}

The signals above mean a human already noticed them repeating something. Trust that. If you can name a specific, mechanical piece of work — searching, comparing, listing, computing, reconciling, drafting — then PROPOSE IT, even at "medium" or "low" confidence. Repetitive file, disk, data, and research chores are exactly what you should offer to do.

Worked example — signals "returned to System Settings 'Storage' 2×" + "repeated 'Copy' in Finder" + a Finder window named after an external drive:
{"goal":"Free up space on the Mac by moving files onto the external drive",
 "offer":"You've checked Storage twice while copying to LaCie — want me to list which folders exist on both drives and how much deleting the Mac copies would reclaim?",
 "confidence":"medium",
 "handoff":{"goal":"Find folders duplicated between the Mac and /Volumes/LaCie and report reclaimable space","context":"User repeatedly checked System Settings > Storage and ran Finder copies toward LaCie; Macintosh HD has 32Gi free of 460Gi."}}

Return {"goal": null} ONLY when you genuinely cannot name a specific action — they're just reading/chatting/in a meeting, the signals are incoherent, or the task needs their judgement, credentials, or a physical action. Do not decline merely because you're unsure it's wanted; that's what "low" confidence and the user's dismiss button are for.`;
}

export function parseAssistProposal(raw: string): Omit<AssistProposal, 'goalKey'> | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as {
      goal?: unknown;
      offer?: unknown;
      confidence?: unknown;
      handoff?: { goal?: unknown; context?: unknown };
    };
    if (typeof obj.goal !== 'string' || !obj.goal.trim()) return undefined; // includes the {"goal": null} case
    if (typeof obj.offer !== 'string' || !obj.offer.trim()) return undefined;
    const handoffGoal =
      obj.handoff && typeof obj.handoff.goal === 'string' && obj.handoff.goal.trim()
        ? obj.handoff.goal.trim()
        : obj.goal.trim();
    const confidence =
      obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low'
        ? obj.confidence
        : 'medium';
    return {
      goal: obj.goal.trim(),
      offer: obj.offer.trim(),
      confidence,
      handoff: {
        goal: handoffGoal,
        context: obj.handoff && typeof obj.handoff.context === 'string' ? obj.handoff.context : '',
      },
    };
  } catch {
    return undefined;
  }
}

const GOAL_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'for', 'on', 'in', 'my', 'its', 'their',
  'from', 'with', 'by', 'up', 'onto', 'into', 'that', 'this', 'so', 'you', 'your',
]);

/**
 * Normalized goal identity. Keeps the full significant-token set (NOT a
 * truncated slice): the model phrases the same goal differently minute to
 * minute — "offloading large media onto the LaCie" vs "moving large media
 * folders to the LaCie" — and a truncated key made those look like different
 * goals, which would have re-offered the same help. Compare with `sameGoal`.
 */
export function goalKeyOf(goal: string): string {
  return [
    ...new Set(
      goal
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !GOAL_STOPWORDS.has(w)),
    ),
  ]
    .sort()
    .join('-');
}

/** Jaccard overlap of two goal keys — same goal when they share enough vocabulary. */
export function goalSimilarity(a: string, b: string): number {
  const ta = new Set(a.split('-').filter(Boolean));
  const tb = new Set(b.split('-').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Threshold tuned on real re-phrasings of the same goal (see goalKeyOf). */
export const SAME_GOAL_THRESHOLD = 0.34;

export function sameGoal(a: string, b: string): boolean {
  return goalSimilarity(a, b) >= SAME_GOAL_THRESHOLD;
}

/** Has this goal already been offered (allowing for re-phrasing)? */
export function alreadyOffered(goalKey: string, offered: string[]): boolean {
  return offered.some((prev) => sameGoal(goalKey, prev));
}

/** One model call. Returns undefined when no offer is warranted (the common case). */
export async function proposeAssist(
  input: AssistInput,
  opts: AssistOptions = {},
): Promise<AssistProposal | undefined> {
  const call = opts.runModel ?? runModel;
  const raw = await call(buildAssistProposalPrompt(input), opts.model);
  const parsed = parseAssistProposal(raw);
  if (!parsed) return undefined;
  return { ...parsed, goalKey: goalKeyOf(parsed.goal) };
}

/** The prompt the assist session opens with — task, evidence, and the hard rules. */
export function buildLiveAssistPrompt(proposal: AssistProposal, workspace: string): string {
  return `# Help the user finish: ${proposal.handoff.goal}

Context Autopilot noticed them working on this and they accepted an offer of help. Pick up mid-task — don't restart what's already done.

## What was observed
${proposal.handoff.context || '(no additional context captured)'}

## What you offered to do
${proposal.offer}

## Your working directory
${workspace} — put any scripts, notes, or output here.

${SAFETY_BRIEF}`;
}
