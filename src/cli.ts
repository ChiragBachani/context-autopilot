#!/usr/bin/env node
/**
 * ctxlayer — Context Autopilot CLI.
 *
 *   ctxlayer projects            list observable projects
 *   ctxlayer scan                mine signals from this project's sessions
 *   ctxlayer distill             scan + distill into proposals
 *   ctxlayer apply               review proposals and write accepted ones
 *   ctxlayer export              export distilled entries as AOP JSON
 */

import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { ClaudeCodeAdapter } from './sources/claude-code.js';
import { buildSignals } from './cluster.js';
import { distill } from './distill.js';
import {
  applyToFile,
  loadProposals,
  readExistingContext,
  renderProposalPreview,
  saveProposals,
} from './propose.js';
import type { ObservedProject, ProposalFile, ProposalTarget, Signal } from './types.js';

interface Flags {
  project?: string;
  model?: string;
  json?: boolean;
  yes?: boolean;
  out?: string;
  minScore: number;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = { minScore: 4 };
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

async function resolveProject(adapter: ClaudeCodeAdapter, flags: Flags): Promise<ObservedProject> {
  const wanted = resolve(flags.project ?? process.cwd());
  const projects = await adapter.discover();
  const byPath = projects.find((p) => p.path && resolve(p.path) === wanted);
  if (byPath) return byPath;
  const bySlug = projects.find((p) => p.id === flags.project);
  if (bySlug) return bySlug;
  fail(
    `No Claude Code sessions found for ${wanted}.\nRun \`ctxlayer projects\` to see observable projects, then pass one with --project <path>.`,
  );
}

async function cmdProjects(adapter: ClaudeCodeAdapter): Promise<void> {
  const projects = await adapter.discover();
  if (projects.length === 0) {
    console.log('No Claude Code projects found under ~/.claude/projects.');
    return;
  }
  console.log(`Observable projects (${projects.length}):\n`);
  for (const p of projects) {
    const when = p.lastActivity ? p.lastActivity.slice(0, 10) : 'unknown';
    console.log(`  ${p.path ?? p.id}`);
    console.log(`      sessions: ${p.sessionCount}   last activity: ${when}`);
  }
}

async function scanSignals(adapter: ClaudeCodeAdapter, flags: Flags): Promise<{ project: ObservedProject; signals: Signal[] }> {
  const project = await resolveProject(adapter, flags);
  const observations = await adapter.observe(project);
  const signals = buildSignals(observations).filter((s) => s.score >= flags.minScore);
  return { project, signals };
}

async function cmdScan(adapter: ClaudeCodeAdapter, flags: Flags): Promise<void> {
  const { project, signals } = await scanSignals(adapter, flags);
  if (flags.json) {
    console.log(JSON.stringify({ project, signals }, null, 2));
    return;
  }
  console.log(`\nScanned ${project.sessionCount} session(s) for ${project.path ?? project.id}`);
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

async function cmdDistill(adapter: ClaudeCodeAdapter, flags: Flags): Promise<void> {
  const { project, signals } = await scanSignals(adapter, flags);
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
    source: 'claude-code',
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

async function cmdApply(adapter: ClaudeCodeAdapter, flags: Flags): Promise<void> {
  const project = await resolveProject(adapter, flags);
  const projectPath = project.path ?? process.cwd();
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

async function cmdExport(adapter: ClaudeCodeAdapter, flags: Flags): Promise<void> {
  const project = await resolveProject(adapter, flags);
  const projectPath = project.path ?? process.cwd();
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
  projects   List projects with observable agent sessions
  scan       Mine repeated instructions, corrections & rejections from sessions
  distill    Distill signals into CLAUDE.md / AGENTS.md proposals
  apply      Review proposals interactively and write accepted ones
  export     Export distilled entries as Agent Operating Procedure JSON

Options:
  -p, --project <path>   Project to analyze (default: current directory)
  -m, --model <model>    Model for distillation (default: your claude CLI default)
      --min-score <n>    Minimum signal strength (default: 4)
  -y, --yes              Accept all proposals without prompting
      --json             Machine-readable output (scan)
  -o, --out <file>       Output file (export)

Distillation uses your local \`claude\` CLI (no API key needed), or the
Anthropic API when ANTHROPIC_API_KEY is set.`);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const adapter = new ClaudeCodeAdapter();
  switch (command) {
    case 'projects':
      return cmdProjects(adapter);
    case 'scan':
      return cmdScan(adapter, flags);
    case 'distill':
      return cmdDistill(adapter, flags);
    case 'apply':
      return cmdApply(adapter, flags);
    case 'export':
      return cmdExport(adapter, flags);
    default:
      return help();
  }
}

main().catch((err) => {
  console.error(`ctxlayer: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
