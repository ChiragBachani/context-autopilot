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

/** One observed moment, reduced to the fields worth matching on. */
export interface ProbeSignal {
  app: string;
  title: string;
}

/**
 * Does the evidence actually concern disk space, drives, or files?
 *
 * Probing unconditionally stapled "35Gi free of 460Gi" onto an apartment-
 * research offer, where it read as a non-sequitur — the facts exist to make an
 * offer concrete, so an irrelevant one is worse than none.
 *
 * Deliberately ignores OCR text and matches on app + window title only. OCR
 * captures the whole screen (menu bars, sidebars, other windows), and the
 * false positive that prompted this was the word "space" picked up from our own
 * dashboard rendering "free space on /" — the probe output feeding itself.
 * Loose tokens are out too: "drive" hits Google Drive, "GB" hits any spec page.
 */
export function storageRelevant(signals: ProbeSignal[], volumeNames: string[] = []): boolean {
  const STORAGE_TITLE =
    /\/Volumes\/|\b(storage|disk utility|time machine|backup|copying|archive utility|free up space)\b/i;
  const FILE_OP = /\b(copy|copying|move to|duplicate|compress|extract|export \d+|import \d+)\b/i;
  const FILE_APP = /^(finder|system settings|disk utility|daisydisk|time machine|image capture)$/i;
  return signals.some(({ app, title }) => {
    if (STORAGE_TITLE.test(title)) return true;
    // A named volume in a window title is unambiguous: they're working a drive.
    if (volumeNames.some((v) => v.length > 2 && title.toLowerCase().includes(v.toLowerCase()))) return true;
    // Finder/Settings alone means nothing (Finder is used for everything) —
    // it has to be paired with a file operation or a storage pane.
    return FILE_APP.test(app.trim()) && FILE_OP.test(title);
  });
}

export interface ProbeContext {
  /** App + window title per observed moment (OCR deliberately excluded). */
  signals: ProbeSignal[];
  /** Absolute paths mentioned in the evidence, if any. */
  candidateDirs?: string[];
}

/** Names of currently mounted volumes, for precise title matching. */
export async function mountedVolumeNames(): Promise<string[]> {
  const out = await run('ls', ['/Volumes']);
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter((s) => s && s !== 'Macintosh HD');
}

/**
 * Run only the probes the situation warrants. Returns whatever succeeded within
 * the time budget — an empty list is a perfectly good answer, and better than
 * facts that have nothing to do with what the user is doing.
 */
export async function gatherProbes(context: ProbeContext): Promise<ProbeFact[]> {
  const volumes = await mountedVolumeNames();
  if (!storageRelevant(context.signals, volumes)) return [];
  const dirs = (context.candidateDirs ?? [])
    .map(probeablePath)
    .filter((d): d is string => Boolean(d))
    .slice(0, 3);
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
