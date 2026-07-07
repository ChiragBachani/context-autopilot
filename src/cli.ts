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
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { discoverAll, observeProject, type SourceName } from './engine.js';
import { buildSignals } from './cluster.js';
import { distill } from './distill.js';
import { findStaleReferences } from './stale.js';
import {
  applyToFile,
  loadProposals,
  readExistingContext,
  renderProposalPreview,
  saveProposals,
} from './propose.js';
import type { ProposalFile, ProposalTarget, Signal } from './types.js';
import type { DiscoveredProject } from './engine.js';

interface Flags {
  project?: string;
  model?: string;
  source: SourceName;
  json?: boolean;
  yes?: boolean;
  out?: string;
  minScore: number;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = { minScore: 4, source: 'all' };
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
        if (s !== 'claude-code' && s !== 'cursor' && s !== 'all') {
          fail(`--source must be claude-code, cursor, or all (got ${s})`);
        }
        flags.source = s;
        break;
      }
      case '--min-score':
        flags.minScore = Number(rest.shift() ?? '4');
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

async function scanSignals(flags: Flags): Promise<{ project: DiscoveredProject; signals: Signal[] }> {
  const wanted = projectDir(flags);
  const result = await observeProject(flags.project ?? wanted, flags.source);
  if (!result) {
    fail(
      `No agent sessions found for ${wanted}.\nRun \`ctxlayer projects\` to see observable projects, then pass one with --project <path>.`,
    );
  }
  const signals = buildSignals(result.observations).filter((s) => s.score >= flags.minScore);
  return { project: result.project, signals };
}

async function cmdScan(flags: Flags): Promise<void> {
  const { project, signals } = await scanSignals(flags);
  if (flags.json) {
    console.log(JSON.stringify({ project, signals }, null, 2));
    return;
  }
  const sources = Object.entries(project.sources)
    .map(([name, count]) => `${count} ${name} session(s)`)
    .join(' + ');
  console.log(`\nScanned ${sources} for ${project.path ?? project.id}`);
  if (signals.length === 0) {
    console.log('No durable signals found yet — signals build up as you work with your agent.');
    return;
  }
  console.log(`Found ${signals.length} signal(s):\n`);
  for (const s of signals) {
    const label = { 'repeated-instruction': 'REPEATED', correction: 'CORRECTION', rejection: 'REJECTION' }[s.kind];
    console.log(`  [${label}] ×${s.observations.length} across ${s.sessions} session(s)  (score ${s.score})`);
    console.log(`      "${s.summary.replace(/\s+/g, ' ').slice(0, 160)}"`);
  }
  console.log(`\nNext: \`ctxlayer distill\` to turn these into CLAUDE.md / AGENTS.md proposals.`);
}

async function cmdDistill(flags: Flags): Promise<void> {
  const { project, signals } = await scanSignals(flags);
  if (signals.length === 0) {
    console.log('No durable signals found — nothing to distill yet.');
    return;
  }
  const projectPath = project.path ?? process.cwd();
  console.log(`Distilling ${signals.length} signal(s) with ${process.env.ANTHROPIC_API_KEY ? 'the Anthropic API' : 'your local `claude` CLI'}…`);
  const existingContext = await readExistingContext(projectPath);
  const proposals = await distill(signals, { existingContext, model: flags.model });
  if (proposals.length === 0) {
    console.log('The distiller found nothing durable enough to propose. Good sign — your context files may already cover it.');
    return;
  }
  const file: ProposalFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    projectPath,
    source: flags.source,
    proposals,
  };
  const saved = await saveProposals(file);
  console.log(`\n${proposals.length} proposal(s) saved to ${saved}:`);
  proposals.forEach((p, i) => console.log(renderProposalPreview(p, i, proposals.length)));
  if (flags.yes) {
    await applyAll(file, () => Promise.resolve(true));
  } else {
    console.log(`\nNext: \`ctxlayer apply\` to review and write the ones you accept.`);
  }
}

async function cmdApply(flags: Flags): Promise<void> {
  const projectPath = projectDir(flags);
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
  const projectPath = projectDir(flags);
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

function help(): void {
  console.log(`Context Autopilot — automated context collection for coding agents
https://thecontextlayer.ai

Usage: ctxlayer <command> [options]

Commands:
  projects   List projects with observable agent sessions (Claude Code + Cursor)
  scan       Mine repeated instructions, corrections & rejections from sessions
  distill    Distill signals into CLAUDE.md / AGENTS.md proposals
  apply      Review proposals interactively and write accepted ones
  stale      Find context-file references the repo has outgrown (exit 1 if any)
  export     Export distilled entries as Agent Operating Procedure JSON

Options:
  -p, --project <path>   Project to analyze (default: current directory)
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
    case 'stale':
      return cmdStale(flags);
    case 'export':
      return cmdExport(flags);
    default:
      return help();
  }
}

main().catch((err) => {
  console.error(`ctxlayer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
