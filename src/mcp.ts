#!/usr/bin/env node
/**
 * Minimal MCP (Model Context Protocol) server over stdio, zero dependencies.
 * Exposes Context Autopilot's scan/distill pipeline as agent-callable tools.
 */

import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverAll, observeEverything, observeProject, type ObservedResult } from './engine.js';
import { buildSignals } from './cluster.js';
import { distill } from './distill.js';
import { findStaleReferences } from './stale.js';
import {
  applyDecisions,
  readExistingContext,
  renderPickerOptions,
  renderUserReport,
  saveProposals,
} from './propose.js';
import { recordDistilledSignals } from './state.js';
import { readAllDays } from './ambient/records.js';
import {
  applyWorkflowDecisions,
  buildEpisodes,
  distillWorkflows,
  findWorkflowCandidates,
  loadAops,
  saveWorkflowProposals,
} from './ambient/workflows.js';
import type { ProposalFile } from './types.js';

const SERVER = { name: 'context-autopilot', version: '0.6.0' };
const PROTOCOL_VERSION = '2025-06-18';

/** Loaded into the agent's context at session start via initialize.instructions. */
const SERVER_INSTRUCTIONS = `Context Autopilot turns the user's own past sessions into agent context rules, with their approval.

Rules for using these tools:
- Distill results contain a section marked USER REPORT — include it in your reply to the user unchanged. The evidence quotes in it are the user's own words and are the entire justification for each rule; never drop or paraphrase them.
- If you collect accept/reject decisions with a structured question / checkbox tool, use the provided PICKER OPTIONS verbatim as the option labels and descriptions (they embed the evidence), and show the USER REPORT in message text first.
- Never call apply_context_proposals until the user has explicitly stated which proposals to accept or reject.
- Proactive use: if the user corrects you more than once in a session, or repeats an instruction they've clearly given before, offer (at a natural pause) to run a distill.`;

/** Wraps a distill result so relaying evidence requires zero composition. */
function distillResultText(report: string, picker: string, applyHint: string): string {
  return `=== USER REPORT (include in your reply to the user unchanged) ===\n${report}\n=== END USER REPORT ===\n\nPICKER OPTIONS — if you use a structured question/checkbox tool for decisions, use exactly these labels/descriptions:\n${picker}\n\nAfter the user states their decisions, ${applyHint} Never apply without their explicit answer.`;
}

const TOOLS = [
  {
    name: 'list_observable_projects',
    description:
      'List projects that have agent session history (Claude Code or Cursor) available for context mining.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'find_stale_context',
    description:
      "Check a project's CLAUDE.md / AGENTS.md for references the repo has outgrown: files that no longer exist and npm scripts that were removed. Returns findings as JSON.",
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path of the project. Defaults to the current working directory.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'apply_context_proposals',
    description:
      "Apply the user's explicit decisions on pending context proposals. Call ONLY after the user has said in conversation which proposals to accept and/or reject — never decide for them. Pass the exact proposal titles. Accepted rules are written into the managed block of the context files; rejected ones are remembered and never re-proposed; unmentioned proposals stay pending.",
    inputSchema: {
      type: 'object',
      properties: {
        accept_titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Titles of proposals the user accepted (may be empty).',
        },
        reject_titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Titles of proposals the user rejected.',
        },
        project_path: {
          type: 'string',
          description: 'Absolute project path the proposals belong to. Defaults to the current working directory.',
        },
        global: {
          type: 'boolean',
          description: 'Set true for global proposals (from distill_global_context); targets ~/.claude.',
        },
      },
      required: ['accept_titles'],
      additionalProperties: false,
    },
  },
  {
    name: 'scan_context_signals',
    description:
      "Mine a project's agent-session history for durable context signals: instructions the user repeated across sessions, corrections they made, and tool calls they rejected. Returns the signals as JSON. Proactively call this when the user has corrected you more than once in a session, or when you notice them repeating an instruction they have given before — if strong signals come back, offer to distill them.",
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path of the project to scan. Defaults to the current working directory.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'distill_global_context',
    description:
      "Mine ALL of the user's projects for cross-project signals about how they like agents to work (verification effort, planning style, workflow preferences) and distill them into proposals for their personal global context file (~/.claude/CLAUDE.md). Proposals are saved to ~/.claude/.ctxlayer/proposals.json for review; nothing is applied automatically. Can take a minute.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'scan_ambient_activity',
    description:
      "Summarize what the ambient screen observer has captured (macOS, 100% local): observed days, captured moments, and workflow candidates — app/window sequences that recur across multiple days. Model-free and fast. If the user hasn't enabled ambient observation, suggest `ctxlayer observe`.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'distill_workflow_proposals',
    description:
      'Mine the ambient screen observations for workflows that recur across days and distill them into Agent Operating Procedure proposals (trigger + step-by-step procedure + evidence). Proposals are saved for review; NOTHING is automated until the user approves via approve_aop. Can take a minute.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'approve_aop',
    description:
      "Apply the user's explicit decisions on pending workflow (AOP) proposals. Call ONLY after the user has said in conversation which workflows to automate — never decide for them. Accepted workflows become Agent Operating Procedures the live observer offers to run; rejected ones are remembered and never re-proposed.",
    inputSchema: {
      type: 'object',
      properties: {
        accept_titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Titles of workflow proposals the user accepted (may be empty).',
        },
        reject_titles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Titles of workflow proposals the user rejected.',
        },
      },
      required: ['accept_titles'],
      additionalProperties: false,
    },
  },
  {
    name: 'distill_context_proposals',
    description:
      'Run the full Context Autopilot pipeline: scan session history, then distill the signals into evidence-backed CLAUDE.md/AGENTS.md proposals. Proposals are saved for review; NOTHING is written to context files until the user approves via apply_context_proposals. Can take a minute. Good moments to proactively suggest this: after the user corrects you repeatedly, or at the natural end of a substantial working session — ask first, then run.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Absolute path of the project. Defaults to the current working directory.',
        },
      },
      additionalProperties: false,
    },
  },
];

async function findProject(projectPath?: string): Promise<ObservedResult> {
  const wanted = projectPath ?? process.cwd();
  const result = await observeProject(wanted);
  if (!result) {
    throw new Error(
      `No agent sessions found for ${wanted}. Use list_observable_projects to see what can be scanned.`,
    );
  }
  return result;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'list_observable_projects') {
    const projects = await discoverAll();
    return JSON.stringify(projects, null, 2);
  }
  if (name === 'find_stale_context') {
    const projectPath = (args.project_path as string | undefined) ?? process.cwd();
    const findings = await findStaleReferences(projectPath);
    return JSON.stringify({ projectPath, findingCount: findings.length, findings }, null, 2);
  }
  if (name === 'scan_context_signals') {
    const { project, observations } = await findProject(args.project_path as string | undefined);
    const signals = buildSignals(observations).filter((s) => s.score >= 4);
    return JSON.stringify(
      {
        project: project.path ?? project.id,
        sources: project.sources,
        signalCount: signals.length,
        signals: signals.map((s) => ({
          kind: s.kind,
          summary: s.summary,
          occurrences: s.observations.length,
          sessions: s.sessions,
          score: s.score,
        })),
      },
      null,
      2,
    );
  }
  if (name === 'apply_context_proposals') {
    const rootPath = args.global
      ? join(homedir(), '.claude')
      : ((args.project_path as string | undefined) ?? process.cwd());
    const result = await applyDecisions(
      rootPath,
      (args.accept_titles as string[]) ?? [],
      (args.reject_titles as string[]) ?? [],
    );
    const written = result.applied
      .map((a) => `${a.created ? 'created' : 'updated'} ${a.path} (managed block: ${a.total} rule(s))`)
      .join('; ');
    return [
      `Accepted: ${result.accepted.length ? result.accepted.join(', ') : 'none'}.`,
      `Rejected: ${result.rejected.length ? result.rejected.join(', ') : 'none'}.`,
      result.unmatched.length ? `WARNING — no pending proposal matched: ${result.unmatched.join(', ')}.` : '',
      written ? `Files: ${written}.` : 'No files written.',
      `${result.stillPending} proposal(s) still pending.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'scan_ambient_activity') {
    const byDay = readAllDays();
    const episodesByDay = new Map<string, ReturnType<typeof buildEpisodes>>();
    for (const [day, records] of byDay) episodesByDay.set(day, buildEpisodes(day, records));
    const candidates = findWorkflowCandidates(episodesByDay);
    return JSON.stringify(
      {
        observedDays: byDay.size,
        capturedMoments: [...byDay.values()].reduce((n, r) => n + r.length, 0),
        automations: loadAops().map((a) => ({ title: a.title, enabled: a.enabled })),
        workflowCandidates: candidates.map((c) => ({
          recurredOnDays: c.days,
          steps: c.episodes[0].steps.map((s) => `[${s.app}] ${s.title}`),
        })),
      },
      null,
      2,
    );
  }
  if (name === 'distill_workflow_proposals') {
    const episodesByDay = new Map<string, ReturnType<typeof buildEpisodes>>();
    for (const [day, records] of readAllDays()) episodesByDay.set(day, buildEpisodes(day, records));
    const candidates = findWorkflowCandidates(episodesByDay);
    if (candidates.length === 0) {
      return 'No repeated workflows found yet — patterns emerge once the ambient observer has seen the same sequence on 2+ days.';
    }
    const proposals = await distillWorkflows(candidates);
    if (proposals.length === 0) return 'The distiller found no coherent, automatable workflows to propose.';
    saveWorkflowProposals(proposals);
    const report = proposals
      .map((p, i) => {
        const e = p.entry;
        const steps = (e.procedure ?? []).map((s) => `   · ${s}`).join('\n');
        const evidence = e.evidence.slice(0, 3).map((ev) => `> ${ev.quote}`).join('\n');
        return `**${i + 1}. ${e.title}** _(${e.confidence} confidence)_\n${e.rule}\n${steps}\n${evidence}`;
      })
      .join('\n\n');
    const picker = proposals
      .map((p, i) => {
        const ev = p.entry.evidence[0];
        return `${i + 1}. label: "${p.entry.title}" — description: "${p.entry.confidence}${ev ? ` · seen: ${ev.quote.slice(0, 80)}` : ''}"`;
      })
      .join('\n');
    return distillResultText(
      `## Workflows Autopilot noticed you doing by hand — automate any of these?\n\n${report}\n\nNothing is automated until you decide. Reply with your choices (e.g. "automate 1, skip 2").`,
      picker,
      'call approve_aop with their exact accept/reject titles.',
    );
  }
  if (name === 'approve_aop') {
    const result = applyWorkflowDecisions(
      (args.accept_titles as string[]) ?? [],
      (args.reject_titles as string[]) ?? [],
    );
    return [
      `Automated: ${result.accepted.length ? result.accepted.join(', ') : 'none'}.`,
      `Rejected: ${result.rejected.length ? result.rejected.join(', ') : 'none'}.`,
      result.unmatched.length ? `WARNING — no pending proposal matched: ${result.unmatched.join(', ')}.` : '',
      result.accepted.length
        ? 'The live observer will now offer to run these when the user starts the workflow.'
        : '',
      `${result.stillPending} proposal(s) still pending.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'distill_global_context') {
    const rootPath = join(homedir(), '.claude');
    const observations = await observeEverything();
    const signals = buildSignals(observations).filter((s) => s.score >= 4);
    if (signals.length === 0) return 'No durable cross-project signals found yet.';
    const existingContext = await readExistingContext(rootPath);
    const proposals = await distill(signals, { existingContext, scope: 'global' });
    await recordDistilledSignals(rootPath, signals);
    if (proposals.length === 0) {
      return 'The distiller found no durable cross-project rules to propose.';
    }
    const file: ProposalFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectPath: rootPath,
      source: 'all',
      proposals,
    };
    await saveProposals(file);
    return distillResultText(
      renderUserReport(proposals, 'global'),
      renderPickerOptions(proposals),
      'call apply_context_proposals with global=true and their exact accept/reject titles.',
    );
  }
  if (name === 'distill_context_proposals') {
    const { project, observations } = await findProject(args.project_path as string | undefined);
    const projectPath = project.path ?? process.cwd();
    const signals = buildSignals(observations).filter((s) => s.score >= 4);
    if (signals.length === 0) return 'No durable signals found — nothing to distill yet.';
    const existingContext = await readExistingContext(projectPath);
    const proposals = await distill(signals, { existingContext });
    await recordDistilledSignals(projectPath, signals);
    if (proposals.length === 0) {
      return 'The distiller found nothing durable enough to propose — existing context files may already cover it.';
    }
    const file: ProposalFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      projectPath,
      source: 'all',
      proposals,
    };
    await saveProposals(file);
    return distillResultText(
      renderUserReport(proposals, 'project'),
      renderPickerOptions(proposals),
      `call apply_context_proposals with project_path "${projectPath}" and their exact accept/reject titles.`,
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function respond(id: number | string | null | undefined, result?: unknown, error?: { code: number; message: string }): void {
  if (id === undefined || id === null) return; // notification — no response
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
}

async function handle(req: JsonRpcRequest): Promise<void> {
  try {
    switch (req.method) {
      case 'initialize':
        respond(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions: SERVER_INSTRUCTIONS,
        });
        break;
      case 'tools/list':
        respond(req.id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const name = String(req.params?.name ?? '');
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await callTool(name, args);
          respond(req.id, { content: [{ type: 'text', text }] });
        } catch (err) {
          respond(req.id, {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          });
        }
        break;
      }
      case 'ping':
        respond(req.id, {});
        break;
      default:
        // Notifications (e.g. notifications/initialized) need no reply.
        if (req.id !== undefined && req.id !== null) {
          respond(req.id, undefined, { code: -32601, message: `Method not found: ${req.method}` });
        }
    }
  } catch (err) {
    respond(req.id, undefined, {
      code: -32603,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  void handle(req);
});
