/**
 * Situation detection — "is the user grinding on something an agent could help
 * with, right now?" Model-free and cheap: it runs on the observer tick, so it
 * must be pure heuristics over the trailing window.
 *
 * This is deliberately different from workflow mining (workflows.ts), which
 * finds routines that RECUR ACROSS DAYS. A first-time goal in progress has no
 * recurrence to match, so it was invisible to the system until now.
 *
 * Thresholds are calibrated for a 5-minute window against real captured data
 * (2026-07-26, a photo-library-to-external-drive cleanup): two Storage checks
 * plus two Copy operations corroborate ~7 minutes into the session — an hour
 * before the user finished by hand. Longer windows or stricter counts push the
 * first useful moment past the point where help still saves work.
 */

import { titleKey } from './workflows.js';
import type { ActivityRecord, ActivitySegment } from './records.js';

export type SituationKind =
  /** Keeps returning to the same surface — usually checking progress on a goal. */
  | 'revisit'
  /** Repeating a manual operation (copy, export, import…) by hand. */
  | 'manual-repetition'
  /** Searching/sweeping across places, reconciling or hunting for something. */
  | 'search-sweep'
  /** A long operation is running — the user is WAITING, so interrupting is free. */
  | 'long-operation'
  /** Bouncing between apps without settling — stuck or hunting. */
  | 'thrash';

export interface Situation {
  kind: SituationKind;
  /** Stable dedupe key, e.g. "revisit:system settings::storage". */
  key: string;
  /** 0..1 — how strongly the window supports this reading. */
  strength: number;
  /** Human-readable one-liner for the prompt and the offer card. */
  detail: string;
  evidence: ActivityRecord[];
}

const OPERATION = /\b(copy|copying|move|moving|export|import|duplicat|compress|upload|archive|extract)/i;
const SEARCHING = /\b(search|searching|find|finding|looking for)\b/i;
const LONG_OPERATION =
  /(export|import|copy|upload|download|backup|sync|render|upgrad|archiv)\w*\s+\d+|\d+\s*%|copying|preparing|processing/i;

/** Context identity for a moment: app + normalized title (matches workflows.ts keys). */
function contextKey(record: ActivityRecord): string {
  return `${record.app.toLowerCase()}::${titleKey(record.windowTitle || '')}`;
}

/**
 * Detect what the user appears to be grinding on. Returns every situation the
 * window supports; the caller decides whether the set is corroborated enough to
 * act on (see `corroborated`).
 */
export function detectSituations(
  records: ActivityRecord[],
  segments: ActivitySegment[] = [],
): Situation[] {
  const situations: Situation[] = [];
  if (records.length === 0) return situations;

  const byContext = new Map<string, ActivityRecord[]>();
  for (const rec of records) {
    const key = contextKey(rec);
    const list = byContext.get(key);
    if (list) list.push(rec);
    else byContext.set(key, [rec]);
  }
  const distinctContexts = byContext.size;

  for (const [key, hits] of byContext) {
    const title = hits[0].windowTitle || '';

    // Returning to the same surface while doing other things between visits is
    // the signature of checking progress ("did the free space go up yet?").
    if (hits.length >= 2 && distinctContexts >= 2) {
      situations.push({
        kind: 'revisit',
        key: `revisit:${key}`,
        strength: Math.min(1, hits.length / 4),
        detail: `returned to ${hits[0].app}${title ? ` — "${title}"` : ''} ${hits.length}× in the last few minutes`,
        evidence: hits,
      });
    }

    // Doing the same operation over and over by hand.
    if (hits.length >= 2 && OPERATION.test(title)) {
      situations.push({
        kind: 'manual-repetition',
        key: `manual:${key}`,
        strength: Math.min(1, hits.length / 4),
        detail: `repeated "${title}" in ${hits[0].app} ${hits.length}×`,
        evidence: hits,
      });
    }
  }

  // Searching across places — hunting or reconciling two sources.
  const searchHits = records.filter((r) => SEARCHING.test(r.windowTitle || ''));
  const distinctSearches = new Set(searchHits.map((r) => titleKey(r.windowTitle || ''))).size;
  if (searchHits.length >= 1) {
    situations.push({
      kind: 'search-sweep',
      key: `search:${[...new Set(searchHits.map((r) => r.app.toLowerCase()))].sort().join(',')}`,
      strength: distinctSearches >= 2 ? 0.9 : 0.5,
      detail: `searching in ${searchHits[0].app}: ${[...new Set(searchHits.map((r) => r.windowTitle))]
        .slice(0, 3)
        .join(', ')}`,
      evidence: searchHits,
    });
  }

  // A long operation is running: the user is waiting anyway, so an offer costs
  // them nothing. Also a strong hint about WHAT they're doing.
  const longOps = records.filter((r) => LONG_OPERATION.test(r.windowTitle || ''));
  if (longOps.length > 0) {
    const last = longOps[longOps.length - 1];
    situations.push({
      kind: 'long-operation',
      key: `longop:${contextKey(last)}`,
      strength: 0.8,
      detail: `"${last.windowTitle}" is running in ${last.app} — they're waiting on it`,
      evidence: longOps,
    });
  }

  // Bouncing without settling: many contexts, little active time in each.
  if (segments.length >= 6) {
    const active = segments.reduce((sum, s) => sum + s.activeSeconds, 0);
    const total = segments.reduce((sum, s) => sum + s.seconds, 0) || 1;
    if (distinctContexts >= 5 && active / total < 0.5) {
      situations.push({
        kind: 'thrash',
        key: `thrash:${[...byContext.keys()].sort().slice(0, 3).join('|')}`,
        strength: 0.5,
        detail: `bounced between ${distinctContexts} contexts without settling`,
        evidence: records.slice(-6),
      });
    }
  }

  situations.sort((a, b) => b.strength - a.strength);
  return situations;
}

/**
 * Is this set of situations strong enough to interrupt over?
 *
 * Early-fire rule: two DISTINCT kinds corroborating, or one kind alongside a
 * running long operation (which costs the user nothing to interrupt). A single
 * weak signal is never enough — that's how an ambient tool becomes noise.
 */
export function corroborated(situations: Situation[]): boolean {
  const kinds = new Set(situations.map((s) => s.kind));
  if (kinds.size >= 2) return true;
  return kinds.has('long-operation') && situations.length >= 2;
}

/** True when the user is waiting on something — interrupting is free. */
export function hasLongOperation(situations: Situation[]): boolean {
  return situations.some((s) => s.kind === 'long-operation');
}
