/**
 * Cheap local probes — the "hybrid" half of Live Assist.
 *
 * An offer backed by a fact ("Macintosh HD has 41 GB free; LaCie has 1.2 TB")
 * is worth far more than a vague "want help?". But speculative work must stay
 * genuinely cheap, so probes are:
 *   - whitelisted commands only, never model calls, never network
 *   - read-only: nothing here can modify anything
 *   - hard-timeout bounded, and degrade silently to "no facts" on failure
 * Anything slower or riskier than this is not probed — it becomes the offer,
 * and gets done only after the user accepts.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** No probe may exceed this. A slow probe is a bug, not a reason to wait. */
const PROBE_TIMEOUT_MS = 2_000;
const MAX_PROBE_CHARS = 1_200;

export interface ProbeFact {
  label: string;
  value: string;
}

async function run(file: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: PROBE_TIMEOUT_MS });
    return stdout.slice(0, MAX_PROBE_CHARS).trim() || undefined;
  } catch {
    return undefined; // timeout, missing binary, permissions — all just "no fact"
  }
}

/**
 * Paths a probe may inspect: under $HOME or /Volumes only. Keeps a bad path
 * from the model or a window title from pointing probes at system internals.
 */
export function probeablePath(candidate: string): string | undefined {
  if (!candidate || !isAbsolute(candidate)) return undefined;
  const path = resolve(candidate);
  if (path.includes('..')) return undefined;
  const home = resolve(homedir());
  if (path === home || path.startsWith(`${home}/`) || path.startsWith('/Volumes/')) return path;
  return undefined;
}

/** Free space per mounted volume. Instant. */
export async function probeDisk(): Promise<ProbeFact[]> {
  const out = await run('df', ['-h']);
  if (!out) return [];
  const facts: ProbeFact[] = [];
  for (const line of out.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const mount = cols.slice(8).join(' ');
    if (mount !== '/' && !mount.startsWith('/Volumes/')) continue;
    facts.push({ label: `free space on ${mount}`, value: `${cols[3]} free of ${cols[1]}` });
  }
  return facts;
}

/** Which external volumes are attached. Instant. */
export async function probeVolumes(): Promise<ProbeFact[]> {
  const out = await run('ls', ['/Volumes']);
  if (!out) return [];
  return [{ label: 'mounted volumes', value: out.split('\n').filter(Boolean).join(', ') }];
}

/** Top-level sizes under one directory. Bounded by the shared timeout. */
export async function probeDirSizes(dir: string): Promise<ProbeFact[]> {
  const safe = probeablePath(dir);
  if (!safe) return [];
  const out = await run('du', ['-sh', '-d', '1', safe]);
  if (!out) return [];
  return [{ label: `sizes under ${safe}`, value: out.replace(/\n/g, ' · ').slice(0, 400) }];
}

/**
 * Run the probes that make sense for a storage/file-shaped situation. Returns
 * whatever succeeded within the time budget — an empty list is fine.
 */
export async function gatherProbes(candidateDirs: string[] = []): Promise<ProbeFact[]> {
  const dirs = candidateDirs.map(probeablePath).filter((d): d is string => Boolean(d)).slice(0, 3);
  const results = await Promise.all([
    probeDisk(),
    probeVolumes(),
    ...dirs.map((d) => probeDirSizes(d)),
  ]);
  return results.flat();
}

export function renderProbeFacts(facts: ProbeFact[]): string {
  if (facts.length === 0) return '(no probe facts available)';
  return facts.map((f) => `- ${f.label}: ${f.value}`).join('\n');
}
