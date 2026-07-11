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
import type { ProposalFile } from './types.js';

const SERVER = { name: 'context-autopilot', version: '0.5.3' };
const PROTOCOL_VERSION = '2025-06-18';

/** Loaded into the agent's context at session start via initialize.instructions. */
const SERVER_INSTRUCTIONS = `Context Autopilot turns the user's own past sessions into agent context rules, with their approval.

Rules for using these tools:
- Present proposals in your chat message and STOP. Distill results contain a section marked USER REPORT — include it in your reply unchanged, as message text, then end your turn and wait for the user's reply. The evidence quotes in it are the user's own words and are the entire justification for each rule; never drop or paraphrase them.
- Decisions happen in chat by default. The user reads the report and replies in plain words ("accept 1 and 3, reject 2"); that is the normal and expected path. Do NOT open a structured question / checkbox picker in the same turn as the report — a picker appears instantly and covers the report the user needs to read first, defeating the purpose.
- Only use a picker if the user EXPLICITLY asks for one (e.g. "give me checkboxes"). If they do, still show the USER REPORT as message text first, then present the picker in a later turn using the provided PICKER OPTIONS verbatim.
- Never call apply_context_proposals until the user has explicitly stated which proposals to accept or reject.
- Proactive use: if the user corrects you more than once in a session, or repeats an instruction they've clearly given before, offer (at a natural pause) to run a distill.`;

/** Wraps a distill result so relaying evidence requires zero composition. */
function distillResultText(report: string, picker: string, applyHint: string): string {
  return `=== USER REPORT (REQUIRED: include in your chat reply unchanged, then STOP and wait for the user) ===\n${report}\n=== END USER REPORT ===\n\nHOW TO COLLECT THE DECISION: Post the report above as your chat message and end your turn. The user replies in plain words ("accept 1 and 3, reject 2"). Do NOT open a checkbox/question picker in this turn — it would cover the report before the user can read it. Only use a picker if the user explicitly asks for checkboxes, and even then show the report as text first. Picker labels, if ever needed:\n${picker}\n\nAfter the user states their decisions, ${applyHint} Never apply without their explicit answer.`;
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
