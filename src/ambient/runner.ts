/**
 * Automation runner: turn an approved AOP into an actual run, with receipts.
 *
 * Attended-auto by design (v1): runs start automatically but execute in a
 * visible `claude` session the user can watch or walk away from. Web
 * workflows get `claude --chrome` (Claude in Chrome integration) so the agent
 * can genuinely drive the browser; everything else runs a plain session.
 *
 * Receipts: every run appends start/finish events to ~/.ctxlayer/aops/runs.jsonl,
 * and the run prompt asks the agent itself to write a 2–3 sentence summary to
 * ~/.ctxlayer/aops/runs/<id>.md when done — the receipt is written by the
 * agent that did the work. Failures notify.
 */

import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ctxlayerHome } from './config.js';
import { launchAgentPath, plist } from './observer.js';
import { renderAopMarkdown, type AopSchedule, type StoredAop } from './workflows.js';

export type RunMode = 'chrome' | 'plain';
export type RunOrigin = 'manual' | 'trigger' | 'scheduled';

export interface RunEvent {
  id: string;
  slug: string;
  event: 'start' | 'finish';
  at: string;
  mode?: RunMode;
  origin?: RunOrigin;
  exitCode?: number;
}

export interface RunRecord {
  id: string;
  slug: string;
  startedAt: string;
  finishedAt?: string;
  mode: RunMode;
  origin: RunOrigin;
  exitCode?: number;
  /** Agent-written 2–3 sentence receipt, when it produced one. */
  summary?: string;
  /** Seconds, when finished. */
  seconds?: number;
}

function runsRoot(): string {
  return join(ctxlayerHome(), 'aops', 'runs');
}

function runsLogPath(): string {
  return join(ctxlayerHome(), 'aops', 'runs.jsonl');
}

export function summaryPath(runId: string): string {
  return join(runsRoot(), `${runId}.md`);
}

/**
 * Web workflow → `claude --chrome`. Pure so tests can hammer it: a URL-ish
 * trigger or any procedure step naming a URL/domain means the work lives in
 * the browser.
 */
export function isWebAop(aop: Pick<StoredAop, 'trigger' | 'procedure'>): boolean {
  if (aop.trigger?.urlPattern) return true;
  const urlish = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|ai|dev|app|co)\b)/i;
  return (aop.procedure ?? []).some((step) => urlish.test(step));
}

export function newRunId(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function appendRunEvent(event: RunEvent): void {
  mkdirSync(join(ctxlayerHome(), 'aops'), { recursive: true });
  appendFileSync(runsLogPath(), JSON.stringify(event) + '\n', 'utf8');
}

/** Fold start/finish events into per-run records, newest first. */
export function readRuns(slug?: string): RunRecord[] {
  const path = runsLogPath();
  if (!existsSync(path)) return [];
  const bySlugId = new Map<string, RunRecord>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: RunEvent;
    try {
      e = JSON.parse(line) as RunEvent;
    } catch {
      continue;
    }
    if (slug && e.slug !== slug) continue;
    const existing = bySlugId.get(e.id);
    if (e.event === 'start') {
      bySlugId.set(e.id, {
        id: e.id,
        slug: e.slug,
        startedAt: e.at,
        mode: e.mode ?? 'plain',
        origin: e.origin ?? 'manual',
      });
    } else if (existing) {
      existing.finishedAt = e.at;
      existing.exitCode = e.exitCode;
      existing.seconds = Math.max(0, Math.round((Date.parse(e.at) - Date.parse(existing.startedAt)) / 1000));
    }
  }
  const runs = [...bySlugId.values()];
  for (const run of runs) {
    const p = summaryPath(run.id);
    if (existsSync(p)) {
      try {
        run.summary = readFileSync(p, 'utf8').trim().slice(0, 600);
      } catch {
        // unreadable receipt — the run record still stands
      }
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

/** The full prompt a run's agent receives: procedure + receipt instruction. */
export function buildRunPrompt(aop: StoredAop, runId: string): string {
  return (
    renderAopMarkdown(aop) +
    `\n## When you finish\n\nWrite a 2–3 sentence summary of what you actually did (and anything that needs the user's attention) to the file \`${summaryPath(runId)}\` — this is the run's receipt shown on the Context Autopilot dashboard.\n`
  );
}

// ---------------------------------------------------------------------------
// Schedules — a LaunchAgent per scheduled automation

function scheduleLabel(slug: string): string {
  return `ai.thecontextlayer.aop.${slug}`;
}

/** StartCalendarInterval XML: one dict per weekday (or one dict = daily). */
export function scheduleCalendarXml(schedule: AopSchedule): string {
  const dict = (extra: string) =>
    `      <dict>${extra}<key>Hour</key><integer>${schedule.hour}</integer><key>Minute</key><integer>${schedule.minute}</integer></dict>`;
  const days = schedule.weekdays?.length
    ? schedule.weekdays.map((d) => dict(`<key>Weekday</key><integer>${d}</integer>`))
    : [dict('')];
  return `    <key>StartCalendarInterval</key>\n    <array>\n${days.join('\n')}\n    </array>`;
}

/**
 * Make launchd agree with the AOP: enabled + scheduled → agent exists and is
 * loaded; otherwise → unloaded and removed. Safe to call on every save.
 */
export function syncAopSchedule(aop: Pick<StoredAop, 'slug' | 'enabled' | 'schedule'>): 'installed' | 'removed' | 'none' {
  const path = launchAgentPath(scheduleLabel(aop.slug));
  if (aop.enabled && aop.schedule) {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    writeFileSync(
      path,
      plist(scheduleLabel(aop.slug), [process.execPath, cli, 'run-aop', aop.slug, '--scheduled'], scheduleCalendarXml(aop.schedule)),
      'utf8',
    );
    execFile('launchctl', ['unload', path], () => {
      execFile('launchctl', ['load', path], () => {});
    });
    return 'installed';
  }
  if (existsSync(path)) {
    execFile('launchctl', ['unload', path], () => {});
    rmSync(path, { force: true });
    return 'removed';
  }
  return 'none';
}

export interface RunResult {
  id: string;
  exitCode: number;
  mode: RunMode;
}

/**
 * Execute an AOP in a visible claude session, inheriting this terminal's
 * stdio. Resolves when the session ends; the receipt trail is written
 * regardless of outcome.
 */
export function runAop(aop: StoredAop, origin: RunOrigin = 'manual'): Promise<RunResult> {
  const id = newRunId();
  const mode: RunMode = isWebAop(aop) ? 'chrome' : 'plain';
  mkdirSync(runsRoot(), { recursive: true });
  appendRunEvent({ id, slug: aop.slug, event: 'start', at: new Date().toISOString(), mode, origin });

  // acceptEdits: this is an automation the user pre-approved to run, watched
  // (attended-auto) — auto-accept file edits (so the work and the receipt
  // flow without nagging) while still prompting for riskier tools (bash, etc).
  // Arg order matters: --add-dir is variadic (consumes following args as more
  // dirs), so the prompt goes first and --add-dir last. --add-dir grants the
  // session write access to the receipts folder.
  const args = mode === 'chrome' ? ['--chrome'] : [];
  args.push('--permission-mode', 'acceptEdits');
  args.push(buildRunPrompt(aop, id), '--add-dir', runsRoot());

  return new Promise((resolve) => {
    const child = spawn('claude', args, { stdio: 'inherit' });
    const finish = (exitCode: number) => {
      appendRunEvent({ id, slug: aop.slug, event: 'finish', at: new Date().toISOString(), exitCode });
      resolve({ id, exitCode, mode });
    };
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', () => finish(127)); // claude CLI missing/unlaunchable
  });
}
