#!/usr/bin/env node
/**
 * ctxlayer — Context Autopilot CLI.
 *
 *   ctxlayer projects            list observable projects (all sources)
 *   ctxlayer scan                mine signals from this project's sessions
 *   ctxlayer distill             scan + distill into proposals
 *   ctxlayer apply               review proposals and write accepted ones
 *   ctxlayer stale               find context-file references the repo outgrew
 *   ctxlayer export              export distilled entries as AOP JSON
 */

import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverAll, observeEverything, observeProject, type SourceName } from './engine.js';
import { loadConfig, pauseFor, setEnabled } from './ambient/config.js';
import { startDashboard } from './ambient/dashboard.js';
import { enterDemoMode, runDemoPipeline } from './ambient/demo.js';
import {
  checkPermissions,
  installLaunchAgents,
  notify,
  observerAlive,
  runObserver,
  uninstallLaunchAgents,
} from './ambient/observer.js';
import { dayKey, readAllDays, readDay } from './ambient/records.js';
import { launchMenuBar, menubarBinary } from './ambient/menubar.js';
import { buildAppBundle, writeDaemonScript } from './ambient/app.js';
import { generateAndSaveRecap, loadRecap, narrateDay, renderSummaryText, summarizeDayFromDisk } from './ambient/summarize.js';
import {
  applyWorkflowDecisions,
  buildEpisodes,
  distillWorkflows,
  findWorkflowCandidates,
  loadAops,
  loadWorkflowProposals,
  saveWorkflowProposals,
} from './ambient/workflows.js';
import { buildSignals } from './cluster.js';
import { distill } from './distill.js';
import { readToolAccesses } from './sources/claude-code.js';
import { aggregateAccesses, applyCodemap, generateCodemap, renderCodemapBlock, shouldSuggestMap } from './codemap.js';
import { findStaleReferences } from './stale.js';
import {
  applyToFile,
  loadProposals,
  readExistingContext,
  renderProposalPreview,
  saveProposals,
} from './propose.js';
import { freshSignals, loadDistilledFingerprints, recordDistilledSignals } from './state.js';
import type { ProposalFile, ProposalTarget, Signal } from './types.js';

interface Flags {
  project?: string;
  model?: string;
  source: SourceName;
  global?: boolean;
  json?: boolean;
  yes?: boolean;
  hook?: boolean;
  out?: string;
  minScore: number;
  threshold: number;
  // ambient (observe / distill --source screen)
  demo?: boolean;
  install?: boolean;
  uninstall?: boolean;
  status?: boolean;
  pause?: number;
  agent?: boolean;
  notify?: boolean;
  narrate?: boolean;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = { minScore: 4, source: 'all', threshold: 3 };
  let command = 'help';
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) command = rest.shift()!;
  while (rest.length) {
    const arg = rest.shift()!;
    switch (arg) {
      case '--project':
      case '-p':
        flags.project = rest.shift();
        break;
      case '--model':
      case '-m':
        flags.model = rest.shift();
        break;
      case '--source':
      case '-s': {
        const s = rest.shift();
        if (s !== 'claude-code' && s !== 'cursor' && s !== 'screen' && s !== 'all') {
          fail(`--source must be claude-code, cursor, screen, or all (got ${s})`);
        }
        flags.source = s;
        break;
      }
      case '--demo':
        flags.demo = true;
        break;
      case '--install':
        flags.install = true;
        break;
      case '--uninstall':
        flags.uninstall = true;
        break;
      case '--status':
        flags.status = true;
        break;
      case '--pause':
        flags.pause = Number(rest.shift() ?? '30');
        break;
      case '--agent':
        flags.agent = true;
        break;
      case '--notify':
        flags.notify = true;
        break;
      case '--narrate':
        flags.narrate = true;
        break;
      case '--global':
      case '-g':
        flags.global = true;
        break;
      case '--min-score':
        flags.minScore = Number(rest.shift() ?? '4');
        break;
      case '--threshold':
        flags.threshold = Number(rest.shift() ?? '3');
        break;
      case '--hook':
        flags.hook = true;
        break;
      case '--out':
      case '-o':
        flags.out = rest.shift();
        break;
      case '--json':
        flags.json = true;
        break;
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case '--help':
      case '-h':
        command = 'help';
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return { command, flags };
}

function fail(message: string): never {
  console.error(`ctxlayer: ${message}`);
  process.exit(1);
}

function projectDir(flags: Flags): string {
  return resolve(flags.project ?? process.cwd());
}

async function cmdProjects(flags: Flags): Promise<void> {
  const projects = await discoverAll(flags.source);
  if (flags.json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (projects.length === 0) {
    console.log('No observable projects found (looked for Claude Code and Cursor session history).');
    return;
  }
  console.log(`Observable projects (${projects.length}):\n`);
  for (const p of projects) {
    const when = p.lastActivity ? p.lastActivity.slice(0, 10) : 'unknown';
    const sources = Object.entries(p.sources)
      .map(([name, count]) => `${name}: ${count} session(s)`)
      .join(', ');
    console.log(`  ${p.path ?? p.id}`);
    console.log(`      ${sources}   last activity: ${when}`);
  }
}

interface ScanResult {
  /** What was scanned, for display. */
  scanned: string;
  /** Where proposals and context files live for this scope. */
  rootPath: string;
  signals: Signal[];
}

/** Global mode reads/writes the user's personal context under ~/.claude. */
function globalRoot(): string {
  return join(homedir(), '.claude');
}

async function scanSignals(flags: Flags): Promise<ScanResult>;
async function scanSignals(flags: Flags, opts: { soft: boolean }): Promise<ScanResult | undefined>;
async function scanSignals(flags: Flags, opts?: { soft: boolean }): Promise<ScanResult | undefined> {
  if (flags.global) {
    const observations = await observeEverything(flags.source);
    const projects = new Set(observations.map((o) => o.project)).size;
    const signals = buildSignals(observations).filter((s) => s.score >= flags.minScore);
    return { scanned: `${projects} project(s) (global)`, rootPath: globalRoot(), signals };
  }
  const wanted = projectDir(flags);
  const result = await observeProject(flags.project ?? wanted, flags.source);
  if (!result) {
    if (opts?.soft) return undefined;
    fail(
      `No agent sessions found for ${wanted}.\nRun \`ctxlayer projects\` to see observable projects, then pass one with --project <path>.`,
    );
  }
  const sources = Object.entries(result.project.sources)
    .map(([name, count]) => `${count} ${name} session(s)`)
    .join(' + ');
  const signals = buildSignals(result.observations).filter((s) => s.score >= flags.minScore);
  return { scanned: `${sources} for ${result.project.path ?? result.project.id}`, rootPath: result.project.path ?? process.cwd(), signals };
}

async function cmdScan(flags: Flags): Promise<void> {
  if (flags.source === 'screen') return cmdScanScreen(flags);
  const { scanned, signals } = await scanSignals(flags);
  if (flags.json) {
    console.log(JSON.stringify({ scanned, signals }, null, 2));
    return;
  }
  console.log(`\nScanned ${scanned}`);
  if (signals.length === 0) {
    console.log('No durable signals found yet — signals build up as you work with your agent.');
    return;
  }
  console.log(`Found ${signals.length} signal(s):\n`);
  for (const s of signals) {
    const label = { 'repeated-instruction': 'REPEATED', correction: 'CORRECTION', rejection: 'REJECTION' }[s.kind];
    const spread = s.projects > 1 ? `${s.sessions} session(s), ${s.projects} projects` : `${s.sessions} session(s)`;
    console.log(`  [${label}] ×${s.observations.length} across ${spread}  (score ${s.score})`);
    console.log(`      "${s.summary.replace(/\s+/g, ' ').slice(0, 160)}"`);
  }
  console.log(`\nNext: \`ctxlayer distill${flags.global ? ' --global' : ''}\` to turn these into context proposals.`);
}

async function cmdDistill(flags: Flags): Promise<void> {
  if (flags.source === 'screen') return cmdDistillScreen(flags);
  const { rootPath, signals } = await scanSignals(flags);
  if (signals.length === 0) {
    console.log('No durable signals found — nothing to distill yet.');
    return;
  }
  console.log(`Distilling ${signals.length} signal(s) with ${process.env.ANTHROPIC_API_KEY ? 'the Anthropic API' : 'your local `claude` CLI'}…`);
  const existingContext = await readExistingContext(rootPath);
  const proposals = await distill(signals, {
    existingContext,
    model: flags.model,
    scope: flags.global ? 'global' : 'project',
  });
  // These signals have now been reviewed by the distiller — `check` should
  // only nudge again once genuinely new evidence accumulates.
  await recordDistilledSignals(rootPath, signals);
  if (proposals.length === 0) {
    console.log('The distiller found nothing durable enough to propose. Good sign — your context files may already cover it.');
    return;
  }
  const file: ProposalFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectPath: rootPath,
    source: flags.source,
    proposals,
  };
  const saved = await saveProposals(file);
  console.log(`\n${proposals.length} proposal(s) saved to ${saved}:`);
  proposals.forEach((p, i) => console.log(renderProposalPreview(p, i, proposals.length)));
  if (flags.yes) {
    await applyAll(file, () => Promise.resolve(true));
  } else {
    console.log(`\nNext: \`ctxlayer apply${flags.global ? ' --global' : ''}\` to review and write the ones you accept.`);
  }
}

async function cmdApply(flags: Flags): Promise<void> {
  const projectPath = flags.global ? globalRoot() : projectDir(flags);
  const file = await loadProposals(projectPath);
  if (!file || file.proposals.length === 0) {
    fail(`No proposals found for ${projectPath}. Run \`ctxlayer distill\` first.`);
  }
  const pending = file.proposals.filter((p) => p.status === 'pending');
  if (pending.length === 0) {
    console.log('All proposals have already been reviewed.');
    return;
  }
  if (flags.yes) {
    await applyAll(file, () => Promise.resolve(true));
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await applyAll(file, async (preview) => {
      console.log(preview);
      const answer = (await rl.question('    accept? [y/N] ')).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    });
  } finally {
    rl.close();
  }
}

async function applyAll(
  file: ProposalFile,
  decide: (preview: string) => Promise<boolean>,
): Promise<void> {
  const pending = file.proposals.filter((p) => p.status === 'pending');
  const accepted: typeof pending = [];
  for (let i = 0; i < pending.length; i++) {
    const ok = await decide(renderProposalPreview(pending[i], i, pending.length));
    pending[i].status = ok ? 'accepted' : 'rejected';
    if (ok) accepted.push(pending[i]);
  }
  await saveProposals(file);
  if (accepted.length === 0) {
    console.log('\nNo proposals accepted.');
    return;
  }
  const targets = new Set<ProposalTarget>();
  for (const p of accepted) for (const t of p.targets) targets.add(t);
  for (const target of targets) {
    const entries = accepted.filter((p) => p.targets.includes(target)).map((p) => p.entry);
    const result = await applyToFile(file.projectPath, target, entries);
    console.log(
      `\n${result.created ? 'Created' : 'Updated'} ${result.path} — managed block now has ${result.total} learned convention(s).`,
    );
  }
}

/**
 * Fast, model-free check: have new durable signals accumulated since the
 * last distill run? `--hook` mode prints a nudge for the agent's context
 * when the threshold is met, and stays completely silent otherwise —
 * designed for a Claude Code SessionStart hook.
 */
async function cmdCheck(flags: Flags): Promise<void> {
  // Soft failure: a hook must never break session start.
  const result = await scanSignals(flags, { soft: true });
  if (!result) {
    if (!flags.hook && !flags.json) console.log('No agent sessions found for this project.');
    return;
  }
  const seen = await loadDistilledFingerprints(result.rootPath);
  const fresh = freshSignals(result.signals, seen);
  if (flags.json) {
    console.log(JSON.stringify({ scanned: result.scanned, newSignals: fresh.length, threshold: flags.threshold }, null, 2));
    return;
  }
  if (flags.hook) {
    const nudges: string[] = [];
    if (fresh.length >= flags.threshold) {
      const top = fresh
        .slice(0, 3)
        .map((s) => `"${s.summary.replace(/\s+/g, ' ').slice(0, 100)}"`)
        .join('; ');
      nudges.push(
        `Context Autopilot: ${fresh.length} new durable context signal(s) have accumulated in this project's session history since the last distillation (e.g. ${top}). When there is a natural pause, offer to run \`ctxlayer distill\` and review the proposals with the user — do not run it mid-task or apply anything without their approval.`,
      );
    }
    // Proactive map nudge: lots of agent navigation here but no map yet.
    try {
      const map = await shouldSuggestMap(result.rootPath);
      if (map.suggest) {
        nudges.push(
          `Context Autopilot: this repo has substantial agent navigation but no codebase map. At a natural pause, offer to run \`ctxlayer map\` — it distills an architecture note (key files + where things live) from what agents keep looking up, so future sessions start warm. Ask before running; nothing is written without approval.`,
        );
      }
    } catch {
      // a nudge must never break session start
    }
    if (nudges.length > 0) console.log(nudges.join('\n\n'));
    return;
  }
  if (fresh.length === 0) {
    console.log(`No new signals since the last distill (${result.signals.length} total, all processed).`);
    return;
  }
  console.log(`${fresh.length} new signal(s) since the last distill (of ${result.signals.length} total):\n`);
  for (const s of fresh.slice(0, 10)) {
    console.log(`  [${s.kind}] ×${s.observations.length}  "${s.summary.replace(/\s+/g, ' ').slice(0, 120)}"`);
  }
  console.log(`\nRun \`ctxlayer distill${flags.global ? ' --global' : ''}\` to process them.`);
}

async function cmdStale(flags: Flags): Promise<void> {
  const projectPath = projectDir(flags);
  const findings = await findStaleReferences(projectPath);
  if (flags.json) {
    console.log(JSON.stringify({ projectPath, findings }, null, 2));
    if (findings.length > 0) process.exitCode = 1;
    return;
  }
  if (findings.length === 0) {
    console.log(`No stale references found in ${projectPath} context files.`);
    return;
  }
  console.log(`\n${findings.length} stale reference(s) in ${projectPath}:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.kind}]  ${f.reference}`);
    console.log(`      ${f.detail}`);
  }
  console.log('\nStale context misleads agents — update or remove these references.');
  process.exitCode = 1;
}

async function cmdExport(flags: Flags): Promise<void> {
  const projectPath = flags.global ? globalRoot() : projectDir(flags);
  const file = await loadProposals(projectPath);
  if (!file) fail(`No proposals found for ${projectPath}. Run \`ctxlayer distill\` first.`);
  const aop = {
    format: 'aop/v1',
    project: projectPath,
    generatedAt: file.generatedAt,
    entries: file.proposals.filter((p) => p.status !== 'rejected').map((p) => p.entry),
  };
  const out = flags.out ?? 'aop.json';
  await writeFile(out, JSON.stringify(aop, null, 2) + '\n', 'utf8');
  console.log(`Exported ${aop.entries.length} AOP entr(ies) to ${out}`);
}

/**
 * Codebase map: mine what agents keep re-deriving in this repo (files they
 * read/edit, symbols they grep) and distill an architecture note into the
 * project context file — so the next session starts warm.
 */
async function cmdMap(flags: Flags): Promise<void> {
  const projectPath = projectDir(flags);
  // Peek at the signals first, so a "nothing to map" exit costs no model call.
  const preSignals = aggregateAccesses(await readToolAccesses(projectPath));
  if (preSignals.files.length === 0) {
    console.log(
      `No agent navigation found for ${projectPath}.\nThe codebase map is built from Claude Code sessions in this project — work in it with the agent first, then re-run.`,
    );
    return;
  }
  if (!flags.json) {
    console.log(
      `Mapping ${projectPath} from ${preSignals.sessionsAnalyzed} session(s) (${preSignals.accessCount} tool accesses) with ${process.env.ANTHROPIC_API_KEY ? 'the Anthropic API' : 'your local `claude` CLI'}…`,
    );
  }
  const { signals, result } = await generateCodemap(projectPath, { model: flags.model });
  if (result.files.length === 0 && result.notes.length === 0) {
    console.log('The distiller produced no map — not enough coherent structure yet.');
    return;
  }

  const block = renderCodemapBlock(result);
  if (flags.json) {
    console.log(JSON.stringify({ projectPath, signals, result }, null, 2));
    return;
  }
  console.log('\n' + block + '\n');

  const write = flags.yes ? true : await confirm('Write this map into CLAUDE.md and AGENTS.md?');
  if (!write) {
    console.log('Not written. Re-run with --yes to write, or edit and paste it yourself.');
    return;
  }
  for (const target of ['CLAUDE.md', 'AGENTS.md'] as const) {
    const { path, created } = await applyCodemap(projectPath, target, result);
    console.log(`${created ? 'Created' : 'Updated'} ${path}`);
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Ambient screen observation

function cliPath(): string {
  return fileURLToPath(import.meta.url);
}

function openInBrowser(url: string): void {
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

async function cmdObserve(flags: Flags): Promise<void> {
  if (flags.demo) return cmdObserveDemo(flags);
  if (flags.install) {
    const written = installLaunchAgents(cliPath());
    console.log('Installed background observation:');
    for (const path of written) console.log(`  · ${path}`);
    console.log('\nThe observer now starts at login, and your day is auto-mined for patterns every evening at 9pm.');
    console.log('Remove everything with: ctxlayer observe --uninstall');
    return;
  }
  if (flags.uninstall) {
    const removed = uninstallLaunchAgents();
    console.log(removed.length ? `Removed:\n${removed.map((p) => `  · ${p}`).join('\n')}` : 'Nothing was installed.');
    return;
  }
  if (flags.status) return cmdObserveStatus();
  if (flags.pause !== undefined) {
    const config = pauseFor(flags.pause);
    console.log(`Paused until ${new Date(config.pausedUntil!).toLocaleTimeString()}. Resume early with: ctxlayer on`);
    return;
  }

  const started = await runObserver();
  if (!started) process.exit(1);
  const server = await startDashboard();
  const port = loadConfig().dashboardPort;
  // Keep the revive script fresh so the menu bar app can restart a dead daemon.
  writeDaemonScript(cliPath());
  // Bring up the menu bar app so observation state is glanceable in the top bar
  // (idempotent — the app's pid lock makes a duplicate launch a no-op).
  launchMenuBar();
  if (server && !flags.agent) {
    openInBrowser(`http://localhost:${port}`);
    console.log(`dashboard open at http://localhost:${port} — leave this running; Ctrl-C stops observing.`);
    console.log('menu bar icon added — click it to toggle recording or open the dashboard.');
  }
}

/** Build /Applications/Context Autopilot.app — the double-click entry point. */
async function cmdApp(): Promise<void> {
  const result = buildAppBundle(cliPath());
  if (!result) {
    fail('Could not build the app (needs the swiftc that ships with Xcode Command Line Tools).');
  }
  console.log(`${result.created ? 'Installed' : 'Updated'} ${result.appPath}`);
  console.log('Open it like any app (Spotlight: "Context Autopilot") — it starts observing and puts the eye in your menu bar.');
  console.log('First launch may ask for Screen Recording permission; flip the toggle once and reopen.');
}

async function cmdMenubar(): Promise<void> {
  if (menubarBinary() === null) {
    fail('Could not build the menu bar app (needs the swiftc that ships with Xcode Command Line Tools).');
  }
  launchMenuBar();
  console.log('Context Autopilot menu bar app is running — look for the eye icon in your top bar.');
  console.log('Green = observing · yellow = paused · gray = off. Click it to toggle or open the dashboard.');
}

async function cmdObserveStatus(): Promise<void> {
  const config = loadConfig();
  const permissions = await checkPermissions();
  const paused = config.pausedUntil && new Date().toISOString() < config.pausedUntil;
  const today = readDay(dayKey());
  console.log(`Ambient observation: ${config.enabled ? (paused ? `PAUSED until ${config.pausedUntil}` : 'ON') : 'OFF'}`);
  console.log(`Observer daemon:     ${observerAlive() ? 'running' : 'not running'}`);
  console.log(`Permissions:         screen recording ${permissions.screen}, accessibility ${permissions.accessibility}`);
  console.log(`Today:               ${today.length} moment(s) captured`);
  console.log(`Dashboard:           http://localhost:${config.dashboardPort}`);
  console.log(`Automations:         ${loadAops().length} AOP(s)`);
}

async function cmdObserveDemo(flags: Flags): Promise<void> {
  enterDemoMode();
  console.log('Context Autopilot — ambient demo (synthetic data, real pipeline, zero permissions needed)');
  let port = loadConfig().dashboardPort;
  let server = await startDashboard(port);
  if (!server) {
    port += 1;
    server = await startDashboard(port);
  }
  if (server) openInBrowser(`http://localhost:${port}`);
  await runDemoPipeline((line) => console.log(line), { model: flags.model });
  console.log(`\nExplore the dashboard at http://localhost:${port} — approve the pattern on the Patterns tab,`);
  console.log('then try "Run now" on the Automations tab. Ctrl-C when done.');
}

function cmdOnOff(enabled: boolean): void {
  setEnabled(enabled);
  if (enabled) {
    console.log('Ambient observation is ON.');
    if (!observerAlive()) console.log('The observer daemon is not running — start it with: ctxlayer observe');
  } else {
    console.log('Ambient observation is OFF — nothing will be captured until `ctxlayer on`. This survives restarts.');
  }
}

async function cmdDashboard(): Promise<void> {
  const port = loadConfig().dashboardPort;
  const server = await startDashboard(port);
  if (!server) {
    // A daemon is already serving it — just open the page.
    openInBrowser(`http://localhost:${port}`);
    console.log(`dashboard already running at http://localhost:${port} — opened it.`);
    return;
  }
  openInBrowser(`http://localhost:${port}`);
  console.log(`dashboard at http://localhost:${port} — Ctrl-C to stop.`);
}

async function cmdSummary(flags: Flags): Promise<void> {
  const day = dayKey();
  const summary = summarizeDayFromDisk(day);
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log('\n' + renderSummaryText(summary));
  if (summary.segmentCount === 0) {
    console.log('\nStart observing with `ctxlayer observe`, then work as usual — this fills in through the day.');
    return;
  }
  // A model narrative is opt-in (costs a call); stats above are always free.
  if (flags.narrate) {
    console.log('\nRecap:');
    console.log('  ' + (await narrateDay(summary, { model: flags.model })).replace(/\n/g, '\n  '));
  } else {
    console.log('\nAdd --narrate for a plain-English recap of your day.');
  }
}

/**
 * Generate + persist today's recap. `--notify` is the observer's first-win
 * path: quiet, fire a notification only when a recap was actually produced.
 */
async function cmdRecap(flags: Flags): Promise<void> {
  const day = dayKey();
  try {
    const recap = await generateAndSaveRecap(day, { model: flags.model });
    if (!recap) {
      if (!flags.notify) console.log('Nothing observed yet today — no recap to write.');
      return;
    }
    if (flags.notify) {
      notify('Context Autopilot', 'Your day so far, summarized — open the dashboard to read it.');
      return;
    }
    console.log('\n' + recap.narrative + '\n');
    console.log(`(saved — the dashboard shows this instantly now; generated ${recap.generatedAt.slice(11, 16)} UTC)`);
  } catch (err) {
    if (!flags.notify) throw err; // background path must never crash loudly
  }
}

function screenCandidates() {
  const episodesByDay = new Map<string, ReturnType<typeof buildEpisodes>>();
  for (const [day, records] of readAllDays()) episodesByDay.set(day, buildEpisodes(day, records));
  return findWorkflowCandidates(episodesByDay);
}

async function cmdScanScreen(flags: Flags): Promise<void> {
  const byDay = readAllDays();
  const candidates = screenCandidates();
  if (flags.json) {
    console.log(JSON.stringify({ days: byDay.size, candidates }, null, 2));
    return;
  }
  const total = [...byDay.values()].reduce((n, r) => n + r.length, 0);
  console.log(`\nScanned ${byDay.size} observed day(s), ${total} captured moment(s)`);
  if (candidates.length === 0) {
    console.log('No repeated workflows detected yet — patterns emerge once the same sequence shows up twice (same day counts).');
    return;
  }
  console.log(`Found ${candidates.length} workflow candidate(s):\n`);
  for (const c of candidates) {
    const steps = c.episodes[0].steps.map((s) => s.app).join(' → ');
    console.log(`  [WORKFLOW] recurred on ${c.days.length} day(s) (${c.days.join(', ')})`);
    console.log(`      ${steps}`);
  }
  console.log('\nNext: `ctxlayer distill --source screen` to turn these into automation proposals.');
}

async function cmdDistillScreen(flags: Flags): Promise<void> {
  const candidates = screenCandidates();
  if (candidates.length === 0) {
    if (!flags.notify) console.log('No repeated workflows to distill yet.');
    return;
  }
  if (!flags.notify) {
    console.log(`Distilling ${candidates.length} workflow candidate(s) with ${process.env.ANTHROPIC_API_KEY ? 'the Anthropic API' : 'your local `claude` CLI'}…`);
  }
  const proposals = await distillWorkflows(candidates, { model: flags.model });
  if (proposals.length === 0) {
    if (!flags.notify) console.log('The distiller found no coherent workflows to propose.');
    return;
  }
  // Auto-distill runs periodically — only ping the user when something NEW
  // showed up, not every time the same unreviewed pattern is re-found.
  const previousTitles = new Set(
    (loadWorkflowProposals()?.proposals ?? []).map((p) => p.entry.title.toLowerCase()),
  );
  const newTitles = proposals.filter((p) => !previousTitles.has(p.entry.title.toLowerCase()));
  saveWorkflowProposals(proposals);
  if (flags.notify) {
    // Background path (nightly agent + idle auto-distill): quiet, never interrupt.
    if (newTitles.length > 0) {
      notify('Context Autopilot', `Found ${newTitles.length} new automatable pattern(s) — open the dashboard to review.`);
    }
    return;
  }
  console.log(`\n${proposals.length} workflow proposal(s):\n`);
  proposals.forEach((p, i) => {
    const e = p.entry;
    console.log(`[${i + 1}/${proposals.length}] ${e.title}  (confidence: ${e.confidence})`);
    console.log(`    ${e.rule}`);
    for (const step of e.procedure ?? []) console.log(`      · ${step}`);
  });
  console.log(`\nReview and approve on the dashboard (ctxlayer dashboard) or with: ctxlayer aop`);
}

async function cmdAop(flags: Flags): Promise<void> {
  const file = loadWorkflowProposals();
  const pending = file?.proposals.filter((p) => p.status === 'pending') ?? [];
  const aops = loadAops();
  if (flags.json) {
    console.log(JSON.stringify({ pending, aops }, null, 2));
    return;
  }
  if (aops.length > 0) {
    console.log(`\n${aops.length} automation(s):`);
    for (const aop of aops) {
      console.log(`  ${aop.enabled ? '●' : '○'} ${aop.title}${aop.trigger ? `  (offers when: ${aop.trigger.app}${aop.trigger.titlePattern ? ` / "${aop.trigger.titlePattern}"` : ''})` : ''}`);
    }
  }
  if (pending.length === 0) {
    console.log(aops.length === 0 ? 'No automations and no pending proposals yet — run `ctxlayer distill --source screen` after a day of observing.' : '\nNo proposals pending review.');
    return;
  }
  console.log(`\n${pending.length} proposal(s) pending review:`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const accept: string[] = [];
  const reject: string[] = [];
  try {
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i].entry;
      console.log(`\n[${i + 1}/${pending.length}] ${e.title}  (confidence: ${e.confidence})`);
      console.log(`    ${e.rule}`);
      for (const step of e.procedure ?? []) console.log(`      · ${step}`);
      for (const ev of e.evidence.slice(0, 3)) console.log(`      evidence: ${ev.quote}`);
      const answer = (await rl.question('    automate this? [y/N] ')).trim().toLowerCase();
      (answer === 'y' || answer === 'yes' ? accept : reject).push(e.title);
    }
  } finally {
    rl.close();
  }
  const result = applyWorkflowDecisions(accept, reject);
  if (result.accepted.length > 0) {
    console.log(`\nSaved ${result.accepted.length} automation(s) — the observer will offer to run them when you start those workflows.`);
  } else {
    console.log('\nNo proposals accepted.');
  }
}

function help(): void {
  console.log(`Context Autopilot — automated context collection for coding agents
https://thecontextlayer.ai

Usage: ctxlayer <command> [options]

Commands:
  projects   List projects with observable agent sessions (Claude Code + Cursor)
  scan       Mine repeated instructions, corrections & rejections from sessions
  distill    Distill signals into CLAUDE.md / AGENTS.md proposals
  apply      Review proposals interactively and write accepted ones
  check      Fast, model-free: any new signals since the last distill?
             (--hook: print a nudge only past --threshold; silent otherwise)
  stale      Find context-file references the repo has outgrown (exit 1 if any)
  map        Distill an architecture note from what agents keep looking up
             (files read/edited, symbols grepped) into CLAUDE.md / AGENTS.md
  export     Export distilled entries as Agent Operating Procedure JSON

Ambient (macOS — screen observation, 100% local):
  observe    Watch your screen at intentional moments; opens the dashboard
             --demo       replay a synthetic day through the real pipeline (no permissions)
             --install    run in the background at login + nightly pattern mining
             --uninstall  remove the background agents
             --status     what's on, what's running, what's captured
             --pause <m>  pause capture for m minutes
  on / off   Master switch for ambient observation (off = instant, persistent)
  dashboard  Open the local dashboard (timeline, patterns, automations, controls)
  journal    Alias for dashboard
  aop        Review workflow proposals in the terminal; list automations
  summary    Today's work at a glance (time per app, focus, cadence); --narrate for a recap
  recap      Generate + save today's plain-English recap (the dashboard shows it instantly)
  menubar    Add the menu bar icon (toggle recording / open dashboard from the top bar)
  app        Install /Applications/Context Autopilot.app — open it and observing just starts
  scan/distill --source screen   mine observed days for repeated workflows

Options:
  -p, --project <path>   Project to analyze (default: current directory)
  -g, --global           Global mode: mine ALL projects for cross-project rules
                         about how you work; writes to ~/.claude/CLAUDE.md
  -s, --source <name>    claude-code | cursor | all (default: all)
  -m, --model <model>    Model for distillation (default: your claude CLI default)
      --min-score <n>    Minimum signal strength (default: 4)
  -y, --yes              Accept all proposals without prompting
      --json             Machine-readable output (scan, projects, stale)
  -o, --out <file>       Output file (export)

Distillation uses your local \`claude\` CLI (no API key needed), or the
Anthropic API when ANTHROPIC_API_KEY is set.`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'projects':
      return cmdProjects(flags);
    case 'scan':
      return cmdScan(flags);
    case 'distill':
      return cmdDistill(flags);
    case 'apply':
      return cmdApply(flags);
    case 'check':
      return cmdCheck(flags);
    case 'stale':
      return cmdStale(flags);
    case 'map':
      return cmdMap(flags);
    case 'export':
      return cmdExport(flags);
    case 'observe':
      return cmdObserve(flags);
    case 'on':
      return cmdOnOff(true);
    case 'off':
      return cmdOnOff(false);
    case 'dashboard':
    case 'journal':
      return cmdDashboard();
    case 'aop':
      return cmdAop(flags);
    case 'summary':
      return cmdSummary(flags);
    case 'recap':
      return cmdRecap(flags);
    case 'menubar':
    case 'tray':
      return cmdMenubar();
    case 'app':
      return cmdApp();
    default:
      return help();
  }
}

main().catch((err) => {
  console.error(`ctxlayer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
