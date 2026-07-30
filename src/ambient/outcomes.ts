/**
 * What happened to each suggestion.
 *
 * offers.jsonl is append-only, so the full history of everything Autopilot ever
 * proposed already exists — but until now nothing recorded the *outcome*, so a
 * suggestion you skipped in the moment was effectively gone. Two reasons that
 * matters: a visible track record is the only honest proof the observer earns
 * its keep, and "not right now" almost never means "never" — a good suggestion
 * at a bad moment should be retrievable later.
 *
 * Deliberately separate from the day-scoped `declinedAssistKeys` in ambient
 * state: that suppresses re-offering (and resets daily), this is a permanent
 * per-offer ledger for display and re-activation.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ambientRoot } from './config.js';

export type OfferStatus = 'accepted' | 'dismissed' | 'open';

export interface OfferOutcome {
  status: Exclude<OfferStatus, 'open'>;
  at: string;
  /** Set when accepting ran a refined version rather than the original. */
  refined?: boolean;
}

function outcomesPath(): string {
  return join(ambientRoot(), 'offer-outcomes.json');
}

export function loadOfferOutcomes(): Record<string, OfferOutcome> {
  if (!existsSync(outcomesPath())) return {};
  try {
    return JSON.parse(readFileSync(outcomesPath(), 'utf8')) as Record<string, OfferOutcome>;
  } catch {
    return {};
  }
}

export function recordOfferOutcome(id: string, outcome: OfferOutcome): void {
  const all = loadOfferOutcomes();
  all[id] = outcome;
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(outcomesPath(), JSON.stringify(all, null, 2) + '\n', 'utf8');
}

/** Re-activating a suggestion clears its old outcome so it reads as live again. */
export function clearOfferOutcome(id: string): void {
  const all = loadOfferOutcomes();
  if (!(id in all)) return;
  delete all[id];
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(outcomesPath(), JSON.stringify(all, null, 2) + '\n', 'utf8');
}
