/**
 * Distiller: turn Signals into evidence-backed AOP entries / context-file
 * proposals, using a model. Prefers the Anthropic API when ANTHROPIC_API_KEY
 * is set; otherwise shells out to the user's `claude` CLI in print mode, so
 * Claude Code users need no separate API key.
 */

import { spawnSync } from 'node:child_process';
import type { AopEntry, Proposal, Signal } from './types.js';

const MAX_SIGNALS = 40;
const MAX_EVIDENCE_PER_SIGNAL = 5;
const MAX_QUOTE_CHARS = 400;

export interface DistillOptions {
  /** Existing context files, so the distiller can dedupe against them. */
  existingContext?: string;
  model?: string;
}

export async function distill(signals: Signal[], opts: DistillOptions = {}): Promise<Proposal[]> {
  const prompt = buildPrompt(signals.slice(0, MAX_SIGNALS), opts.existingContext);
  const raw = process.env.ANTHROPIC_API_KEY
    ? await callApi(prompt, opts.model)
    : callClaudeCli(prompt, opts.model);
  const entries = parseEntries(raw);
  return entries.map((entry) => ({
    entry,
    targets: ['CLAUDE.md', 'AGENTS.md'],
    status: 'pending',
  }));
}

function buildPrompt(signals: Signal[], existingContext?: string): string {
  const evidence = signals
    .map((s, i) => {
      const quotes = s.observations
        .slice(0, MAX_EVIDENCE_PER_SIGNAL)
        .map((o) => {
          const when = o.timestamp ? o.timestamp.slice(0, 10) : 'unknown date';
          const ctx = o.agentContext ? `\n    (agent was doing: ${clip(o.agentContext, 160)})` : '';
          return `  - [${when}, session ${o.sessionId.slice(0, 8)}] "${clip(o.text, MAX_QUOTE_CHARS)}"${ctx}`;
        })
        .join('\n');
      return `### Signal ${i + 1} — ${s.kind} (seen in ${s.sessions} session${s.sessions === 1 ? '' : 's'}, ${s.observations.length}×)\n${quotes}`;
    })
    .join('\n\n');

  return `You are a context distiller for AI coding agents. Below are signals mined from a developer's real agent sessions: instructions they repeated across sessions, corrections they made when the agent got something wrong, and tool calls they rejected.

Your job: distill ONLY the durable, project-specific conventions worth writing into the project's agent context file (CLAUDE.md / AGENTS.md). These are rules the agent should follow in EVERY future session.

Rules:
- Only include rules that are non-obvious and project-specific. Skip generic best practices, one-off task content, and anything an agent would do anyway.
- Each rule must be imperative and at most 2 sentences.
- Ground every rule in the evidence: only propose what the quotes actually support.
- If the existing context file already covers a rule, skip it.
- Rate confidence: "high" = repeated across sessions or an explicit correction; "medium" = plausible but thin evidence; "low" = speculative. Prefer fewer, higher-confidence rules. A focused context file outperforms a bloated one.
- Respond with ONLY a JSON array (no markdown fence, no prose) of objects: {"title": string, "rule": string, "rationale": string, "confidence": "high"|"medium"|"low", "evidence": [{"quote": string, "timestamp": string, "sessionId": string}]}
- If nothing is worth adding, respond with [].

${existingContext ? `## Existing context file (do NOT duplicate anything here)\n${clip(existingContext, 8000)}\n\n` : ''}## Mined signals

${evidence}`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Run the user's claude CLI in print mode, prompt on stdin. */
function callClaudeCli(prompt: string, model?: string): string {
  const args = ['-p', '--output-format', 'text'];
  if (model) args.push('--model', model);
  const res = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  });
  if (res.error) {
    throw new Error(
      `Could not run the \`claude\` CLI (${res.error.message}). Install Claude Code or set ANTHROPIC_API_KEY.`,
    );
  }
  if (res.status !== 0) {
    throw new Error(`\`claude -p\` exited with ${res.status}: ${clip(res.stderr ?? '', 500)}`);
  }
  return res.stdout ?? '';
}

async function callApi(prompt: string, model?: string): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model ?? 'claude-sonnet-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${clip(await response.text(), 500)}`);
  }
  const data = (await response.json()) as { content: { type: string; text?: string }[] };
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Parse the model's output leniently: find the first JSON array in it. */
function parseEntries(raw: string): AopEntry[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: AopEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.title !== 'string' || typeof e.rule !== 'string') continue;
    entries.push({
      title: e.title,
      rule: e.rule,
      rationale: typeof e.rationale === 'string' ? e.rationale : '',
      confidence: e.confidence === 'high' || e.confidence === 'medium' || e.confidence === 'low'
        ? e.confidence
        : 'medium',
      evidence: Array.isArray(e.evidence)
        ? e.evidence
            .filter((ev): ev is Record<string, string> => !!ev && typeof ev === 'object')
            .map((ev) => ({
              quote: String(ev.quote ?? ''),
              timestamp: String(ev.timestamp ?? ''),
              sessionId: String(ev.sessionId ?? ''),
            }))
        : [],
    });
  }
  return entries;
}
