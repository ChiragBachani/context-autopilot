/**
 * Multi-source engine: unifies adapters so the CLI and MCP server can treat
 * "a project" as the merger of every source that observed it.
 */

import { resolve } from 'node:path';
import { ClaudeCodeAdapter } from './sources/claude-code.js';
import { CursorAdapter } from './sources/cursor.js';
import { ScreenAdapter } from './sources/screen.js';
import type { Observation, ObservedProject, SourceAdapter } from './types.js';

export type SourceName = 'claude-code' | 'cursor' | 'screen' | 'all';

export function getAdapters(source: SourceName = 'all'): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  if (source === 'all' || source === 'claude-code') adapters.push(new ClaudeCodeAdapter());
  if (source === 'all' || source === 'cursor') adapters.push(new CursorAdapter());
  // Screen activity is workflow data, not conversational signals — it has its
  // own mining path (ambient/workflows), so it never joins 'all' text scans.
  if (source === 'screen') adapters.push(new ScreenAdapter());
  return adapters;
}

export interface DiscoveredProject {
  path?: string;
  id: string;
  /** sessions per source, e.g. { 'claude-code': 3, cursor: 2 } */
  sources: Record<string, number>;
  sessionCount: number;
  lastActivity?: string;
}

/** Discover projects across sources, merged by real path. */
export async function discoverAll(source: SourceName = 'all'): Promise<DiscoveredProject[]> {
  const merged = new Map<string, DiscoveredProject>();
  for (const adapter of getAdapters(source)) {
    for (const project of await adapter.discover()) {
      const key = project.path ? resolve(project.path) : `${adapter.name}:${project.id}`;
      const existing = merged.get(key);
      if (existing) {
        existing.sources[adapter.name] = (existing.sources[adapter.name] ?? 0) + project.sessionCount;
        existing.sessionCount += project.sessionCount;
        if (project.lastActivity && (!existing.lastActivity || project.lastActivity > existing.lastActivity)) {
          existing.lastActivity = project.lastActivity;
        }
      } else {
        merged.set(key, {
          path: project.path,
          id: project.id,
          sources: { [adapter.name]: project.sessionCount },
          sessionCount: project.sessionCount,
          lastActivity: project.lastActivity,
        });
      }
    }
  }
  const projects = [...merged.values()];
  projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  return projects;
}

export interface ObservedResult {
  project: DiscoveredProject;
  observations: Observation[];
}

/**
 * Observe every project across every source, tagging each observation with
 * its project path. This is the input for global (cross-project) context:
 * rules about how the user works, rather than about any one repo.
 */
export async function observeEverything(source: SourceName = 'all'): Promise<Observation[]> {
  const observations: Observation[] = [];
  for (const adapter of getAdapters(source)) {
    for (const project of await adapter.discover()) {
      const label = project.path ?? project.id;
      for (const obs of await adapter.observe(project)) {
        obs.project = label;
        observations.push(obs);
      }
    }
  }
  observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return observations;
}

/**
 * Observe a project by path (or adapter-specific id), merging observations
 * from every source that knows it.
 */
export async function observeProject(
  wanted: string,
  source: SourceName = 'all',
): Promise<ObservedResult | undefined> {
  const wantedPath = resolve(wanted);
  let matched: DiscoveredProject | undefined;
  const observations: Observation[] = [];
  for (const adapter of getAdapters(source)) {
    for (const project of await adapter.discover()) {
      const isMatch = (project.path && resolve(project.path) === wantedPath) || project.id === wanted;
      if (!isMatch) continue;
      observations.push(...(await adapter.observe(project)));
      if (!matched) {
        matched = {
          path: project.path,
          id: project.id,
          sources: {},
          sessionCount: 0,
          lastActivity: project.lastActivity,
        };
      }
      matched.sources[adapter.name] = (matched.sources[adapter.name] ?? 0) + project.sessionCount;
      matched.sessionCount += project.sessionCount;
    }
  }
  if (!matched) return undefined;
  observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { project: matched, observations };
}
