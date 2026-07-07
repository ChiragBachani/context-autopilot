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
import { applyDecisions, readExistingContext, renderProposalPreview, saveProposals } from './propose.js';
import { recordDistilledSignals } from './state.js';
import type { ProposalFile } from './types.js';

const SERVER = { name: 'context-autopilot', version: '0.4.1' };
const PROTOCOL_VERSION = '2025-06-18';

/**
 * Appended after proposal previews. Placed last because models weight the
 * end of a long tool result most when deciding what to do next — v0.4.0 put
 * this first and agents summarized the evidence away when presenting.
 */
const PRESENTATION_RULES =
  'HOW TO PRESENT THESE TO THE USER (required): show every proposal with its evidence quotes VERBATIM — the quotes are the user\'s own past words and are the entire justification for each rule; never omit or paraphrase them. Then ask which proposals to accept or reject, and only after the user answers, call apply_context_proposals with their exact decisions. Do not apply anything they have not explicitly approved.';

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
    const saved = await saveProposals(file);
    const previews = proposals.map((p, i) => renderProposalPreview(p, i, proposals.length)).join('\n');
    return `${proposals.length} global proposal(s) saved to ${saved}.\n${previews}\n\n${PRESENTATION_RULES} For these global proposals, call apply_context_proposals with global=true.`;
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
    const saved = await saveProposals(file);
    const previews = proposals.map((p, i) => renderProposalPreview(p, i, proposals.length)).join('\n');
    return `${proposals.length} proposal(s) saved to ${saved}.\n${previews}\n\n${PRESENTATION_RULES}`;
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
