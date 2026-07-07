/**
 * Turn raw observations into Signals: clusters of similar instructions that
 * recur across sessions, plus corrections and rejections (which are strong
 * signals even as singletons).
 */

import { normalizeForSimilarity, similarity } from './extract.js';
import type { Observation, Signal } from './types.js';

const SIMILARITY_THRESHOLD = 0.3;
/** Very long prompts are usually one-off task specs, not durable conventions. */
const MAX_INSTRUCTION_WORDS = 250;
/** Very short messages ("Yes", "does this look right?") carry no convention. */
const MIN_INSTRUCTION_WORDS = 4;

export function buildSignals(observations: Observation[]): Signal[] {
  const signals: Signal[] = [];

  const corrections = observations.filter((o) => o.kind === 'correction');
  const rejections = observations.filter((o) => o.kind === 'rejection');
  const instructions = observations.filter((o) => {
    if (o.kind !== 'instruction') return false;
    const words = normalizeForSimilarity(o.text).length;
    return words >= MIN_INSTRUCTION_WORDS && words <= MAX_INSTRUCTION_WORDS;
  });

  // Greedy single-pass clustering of instructions by text similarity.
  const clusters: Observation[][] = [];
  const clusterWords: string[][] = [];
  for (const obs of instructions) {
    const words = normalizeForSimilarity(obs.text);
    if (words.length === 0) continue;
    let placed = false;
    for (let i = 0; i < clusters.length; i++) {
      if (similarity(words, clusterWords[i]) >= SIMILARITY_THRESHOLD) {
        clusters[i].push(obs);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([obs]);
      clusterWords.push(words);
    }
  }

  for (const cluster of clusters) {
    const sessions = distinctSessions(cluster);
    const projects = distinctProjects(cluster);
    // A convention is something you said more than once — require either
    // multiple sessions or 3+ repetitions inside one long session.
    if (sessions < 2 && cluster.length < 3) continue;
    signals.push({
      id: `ri-${signals.length}`,
      kind: 'repeated-instruction',
      summary: representative(cluster),
      observations: cluster,
      sessions,
      projects,
      // Spanning multiple projects is the strongest recurrence signal there is.
      score: sessions * 2 + cluster.length + (projects - 1) * 3,
    });
  }

  // Corrections cluster too (you tend to correct the same mistake), but even
  // a single correction is worth surfacing.
  for (const group of groupBySimilarity(corrections)) {
    const sessions = distinctSessions(group);
    const projects = distinctProjects(group);
    signals.push({
      id: `co-${signals.length}`,
      kind: 'correction',
      summary: representative(group),
      observations: group,
      sessions,
      projects,
      score: sessions * 2 + group.length + 3 + (projects - 1) * 3,
    });
  }

  for (const group of groupBySimilarity(rejections.filter((r) => r.text.length > 40))) {
    const sessions = distinctSessions(group);
    const projects = distinctProjects(group);
    signals.push({
      id: `re-${signals.length}`,
      kind: 'rejection',
      summary: representative(group),
      observations: group,
      sessions,
      projects,
      score: sessions * 2 + group.length + 4 + (projects - 1) * 3,
    });
  }

  signals.sort((a, b) => b.score - a.score);
  return signals;
}

function groupBySimilarity(observations: Observation[]): Observation[][] {
  const groups: Observation[][] = [];
  const groupWords: string[][] = [];
  for (const obs of observations) {
    const words = normalizeForSimilarity(obs.text);
    let placed = false;
    for (let i = 0; i < groups.length; i++) {
      if (similarity(words, groupWords[i]) >= SIMILARITY_THRESHOLD) {
        groups[i].push(obs);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push([obs]);
      groupWords.push(words);
    }
  }
  return groups;
}

function distinctSessions(observations: Observation[]): number {
  return new Set(observations.map((o) => o.sessionId)).size;
}

function distinctProjects(observations: Observation[]): number {
  return new Set(observations.map((o) => o.project ?? '')).size;
}

/** Pick the shortest observation as the cluster's representative text. */
function representative(cluster: Observation[]): string {
  let best = cluster[0].text;
  for (const o of cluster) if (o.text.length < best.length) best = o.text;
  return best.length > 240 ? best.slice(0, 240) + '…' : best;
}
