/**
 * Refinement — talk the suggestion into shape before running it.
 *
 * The most common reason a good suggestion goes unused isn't that it's wrong;
 * it's that it's *almost* right. "Close, but pull from Zillow only" or "skip the
 * screenshots step" should take ten seconds, not a rejection. So both Live
 * Assist offers and mined workflow patterns get a small chat loop: the user says
 * what to change, the model returns a revised version, and they iterate until
 * they're happy — then run it.
 *
 * Two rules keep this honest:
 *  - Refinement NEVER silently drops evidence. The revised entry keeps the
 *    original quotes; the user is adjusting the plan, not rewriting history.
 *  - The model returns the same structured shape it was given, so a refined
 *    proposal is interchangeable with an original one everywhere downstream.
 */

import { runModel } from '../distill.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ambientRoot } from './config.js';
import type { AopEntry } from '../types.js';

export interface RefineTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface RefineOptions {
  model?: string;
  runModel?: (prompt: string, model?: string) => Promise<string>;
}

/** What the user is refining: a Live Assist offer, or a mined workflow. */
export interface OfferDraft {
  kind: 'offer';
  goal: string;
  offer: string;
  handoffGoal: string;
  handoffContext: string;
}

export interface WorkflowDraft {
  kind: 'workflow';
  title: string;
  rule: string;
  procedure: string[];
}

export type Draft = OfferDraft | WorkflowDraft;

function describeDraft(draft: Draft): string {
  if (draft.kind === 'offer') {
    return [
      `goal: ${draft.goal}`,
      `offer: ${draft.offer}`,
      `agent task: ${draft.handoffGoal}`,
      `context the agent gets: ${draft.handoffContext}`,
    ].join('\n');
  }
  return [
    `title: ${draft.title}`,
    `what it does: ${draft.rule}`,
    `steps:\n${draft.procedure.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
  ].join('\n');
}

function outputContract(kind: Draft['kind']): string {
  return kind === 'offer'
    ? `{"goal": "<revised goal>", "offer": "<revised one-sentence offer addressed to the user>", "handoffGoal": "<revised imperative task for the agent>", "handoffContext": "<context the agent needs, including anything the user just told you>", "reply": "<one short sentence telling the user what you changed>"}`
    : `{"title": "<revised title>", "rule": "<revised one-or-two-sentence description>", "procedure": ["<step>", "…"], "reply": "<one short sentence telling the user what you changed>"}`;
}

export function buildRefinePrompt(draft: Draft, history: RefineTurn[], message: string): string {
  const conversation = history
    .slice(-6)
    .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.text}`)
    .join('\n');
  return `You are refining a suggestion the user almost wants to run. They are telling you how to adjust it. Apply their change faithfully — do not re-litigate the idea or expand its scope beyond what they asked.

## Current version
${describeDraft(draft)}

${conversation ? `## Conversation so far\n${conversation}\n` : ''}
## What the user just said
${message}

Revise the suggestion so it matches what they want. Keep everything they didn't ask you to change. If their instruction is ambiguous, make the smallest reasonable interpretation and say so in your reply.

Respond with ONE JSON object and nothing else:
${outputContract(draft.kind)}`;
}

export interface RefinedOffer {
  goal: string;
  offer: string;
  handoffGoal: string;
  handoffContext: string;
  reply: string;
}

export interface RefinedWorkflow {
  title: string;
  rule: string;
  procedure: string[];
  reply: string;
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const str = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

export async function refineOffer(
  draft: OfferDraft,
  history: RefineTurn[],
  message: string,
  opts: RefineOptions = {},
): Promise<RefinedOffer | undefined> {
  const call = opts.runModel ?? runModel;
  const obj = parseJsonObject(await call(buildRefinePrompt(draft, history, message), opts.model));
  if (!obj) return undefined;
  return {
    goal: str(obj.goal, draft.goal),
    offer: str(obj.offer, draft.offer),
    handoffGoal: str(obj.handoffGoal, draft.handoffGoal),
    handoffContext: str(obj.handoffContext, draft.handoffContext),
    reply: str(obj.reply, 'Updated.'),
  };
}

export async function refineWorkflow(
  draft: WorkflowDraft,
  history: RefineTurn[],
  message: string,
  opts: RefineOptions = {},
): Promise<RefinedWorkflow | undefined> {
  const call = opts.runModel ?? runModel;
  const obj = parseJsonObject(await call(buildRefinePrompt(draft, history, message), opts.model));
  if (!obj) return undefined;
  const procedure = Array.isArray(obj.procedure)
    ? obj.procedure.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : draft.procedure;
  return {
    title: str(obj.title, draft.title),
    rule: str(obj.rule, draft.rule),
    procedure: procedure.length > 0 ? procedure : draft.procedure,
    reply: str(obj.reply, 'Updated.'),
  };
}

/**
 * Apply a refinement to a workflow entry, preserving its evidence and trigger.
 * The user is adjusting the plan, not rewriting what was observed.
 */
export function applyWorkflowRefinement(entry: AopEntry, refined: RefinedWorkflow): AopEntry {
  return {
    ...entry,
    title: refined.title,
    rule: refined.rule,
    procedure: refined.procedure,
    evidence: entry.evidence, // never lose the receipts
    trigger: entry.trigger,
  };
}

// ---------------------------------------------------------------------------
// Refinement store for offers (offers.jsonl is append-only, so overlay instead)

export interface OfferRefinement {
  goal: string;
  offer: string;
  handoffGoal: string;
  handoffContext: string;
  chat: RefineTurn[];
}

function refinementsPath(): string {
  return join(ambientRoot(), 'offer-refinements.json');
}

export function loadOfferRefinements(): Record<string, OfferRefinement> {
  if (!existsSync(refinementsPath())) return {};
  try {
    return JSON.parse(readFileSync(refinementsPath(), 'utf8')) as Record<string, OfferRefinement>;
  } catch {
    return {};
  }
}

export function saveOfferRefinement(id: string, refinement: OfferRefinement): void {
  const all = loadOfferRefinements();
  all[id] = refinement;
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(refinementsPath(), JSON.stringify(all, null, 2) + '\n', 'utf8');
}
