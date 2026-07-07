/**
 * Source-agnostic observation schema.
 *
 * Context Autopilot's core loop is: observe work → detect durable signals →
 * distill into agent-readable context. Coding-agent transcripts are the first
 * observation source; browser events and screen capture are future adapters.
 * Everything downstream of a SourceAdapter must depend only on these types.
 */

export type ObservationKind =
  /** The human told the agent what to do. */
  | 'instruction'
  /** The human corrected or pushed back on something the agent did. */
  | 'correction'
  /** The human blocked a proposed action (e.g. rejected a tool call). */
  | 'rejection';

export interface Observation {
  id: string;
  /** Which adapter produced this: 'claude-code', 'cursor', 'browser', 'screen'… */
  source: string;
  kind: ObservationKind;
  /** ISO 8601. */
  timestamp: string;
  sessionId: string;
  /** The human-readable content of the observation. */
  text: string;
  /** What the agent was doing when this happened (for corrections/rejections). */
  agentContext?: string;
}

/** A project the adapter can observe (usually maps to a repo / working dir). */
export interface ObservedProject {
  /** Adapter-specific identifier (e.g. the ~/.claude/projects slug). */
  id: string;
  /** Real working-directory path, when known. */
  path?: string;
  sessionCount: number;
  lastActivity?: string;
}

export interface SourceAdapter {
  name: string;
  discover(): Promise<ObservedProject[]>;
  observe(project: ObservedProject): Promise<Observation[]>;
}

/**
 * A cluster of related observations — one candidate piece of durable context.
 */
export interface Signal {
  id: string;
  kind: 'repeated-instruction' | 'correction' | 'rejection';
  /** Representative text for the cluster. */
  summary: string;
  observations: Observation[];
  /** Number of distinct sessions the observations span. */
  sessions: number;
  /** Heuristic strength; higher = more likely to be durable context. */
  score: number;
}

/**
 * Agent Operating Procedure entry — a distilled, evidence-backed rule an
 * agent should follow. AOPs are the durable artifact; context files
 * (CLAUDE.md / AGENTS.md) are one rendering of them.
 */
export interface AopEntry {
  title: string;
  /** The rule itself, imperative, ≤2 sentences. */
  rule: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: AopEvidence[];
}

export interface AopEvidence {
  quote: string;
  timestamp: string;
  sessionId: string;
}

export type ProposalTarget = 'CLAUDE.md' | 'AGENTS.md';

export interface Proposal {
  entry: AopEntry;
  targets: ProposalTarget[];
  status: 'pending' | 'accepted' | 'rejected';
}

export interface ProposalFile {
  version: 1;
  generatedAt: string;
  projectPath: string;
  source: string;
  proposals: Proposal[];
}
