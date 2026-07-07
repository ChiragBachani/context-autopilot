/**
 * Distillation state: remembers which signals have already been through a
 * distill run, so `ctxlayer check` can tell whether NEW evidence has
 * accumulated since — the basis for proactive nudges. Stored per scope in
 * .ctxlayer/state.json next to proposals.json.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeForSimilarity } from './extract.js';
import type { Signal } from './types.js';

interface StateFile {
  version: 1;
  /** Fingerprints of signals that have been included in a distill run. */
  distilledFingerprints: string[];
}

function statePath(rootPath: string): string {
  return join(rootPath, '.ctxlayer', 'state.json');
}

/**
 * Stable-ish identity for a signal cluster: kind + the first normalized words
 * of its representative text. Clusters grow as evidence accumulates, so this
 * tolerates small changes while distinguishing genuinely new signals.
 */
export function signalFingerprint(signal: Signal): string {
  return `${signal.kind}:${normalizeForSimilarity(signal.summary).slice(0, 12).join(' ')}`;
}

export async function loadDistilledFingerprints(rootPath: string): Promise<Set<string>> {
  try {
    const state = JSON.parse(await readFile(statePath(rootPath), 'utf8')) as StateFile;
    return new Set(state.distilledFingerprints);
  } catch {
    return new Set();
  }
}

/** Record that these signals have been seen by a distill run. */
export async function recordDistilledSignals(rootPath: string, signals: Signal[]): Promise<void> {
  const fingerprints = await loadDistilledFingerprints(rootPath);
  for (const s of signals) fingerprints.add(signalFingerprint(s));
  await mkdir(join(rootPath, '.ctxlayer'), { recursive: true });
  const state: StateFile = { version: 1, distilledFingerprints: [...fingerprints] };
  await writeFile(statePath(rootPath), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/** Signals not yet seen by any distill run. */
export function freshSignals(signals: Signal[], seen: Set<string>): Signal[] {
  return signals.filter((s) => !seen.has(signalFingerprint(s)));
}
