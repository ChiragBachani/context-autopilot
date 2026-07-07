/**
 * Cursor source adapter.
 *
 * Cursor stores agent sessions in SQLite:
 *   <cursor-data>/User/workspaceStorage/<hash>/workspace.json     → project folder
 *   <cursor-data>/User/workspaceStorage/<hash>/state.vscdb        → ItemTable key
 *       'composer.composerData' → allComposers[].composerId
 *   <cursor-data>/User/globalStorage/state.vscdb → cursorDiskKV keys
 *       'composerData:<id>'          → session meta (createdAt, conversation headers)
 *       'bubbleId:<id>:<bubbleId>'   → message ({type: 1=user, 2=assistant, text})
 *
 * Reading SQLite uses the Node 22+ built-in node:sqlite module (read-only),
 * keeping the package dependency-free. On older Node the adapter reports
 * no projects rather than crashing.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation, ObservedProject, SourceAdapter } from '../types.js';
import { classifyCorrection, looksLikeInjectedContent } from '../extract.js';

const require_ = createRequire(import.meta.url);

interface SqliteDb {
  prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any[] };
  close(): void;
}

function openDb(path: string): SqliteDb | undefined {
  try {
    const { DatabaseSync } = require_('node:sqlite');
    return new DatabaseSync(path, { readOnly: true }) as SqliteDb;
  } catch {
    return undefined; // Node < 22 or unreadable database
  }
}

function cursorUserDir(): string {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Cursor', 'User');
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
    default:
      return join(home, '.config', 'Cursor', 'User');
  }
}

function parseValue(value: unknown): any {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface WorkspaceInfo {
  hash: string;
  path: string;
  composerIds: string[];
}

export class CursorAdapter implements SourceAdapter {
  name = 'cursor';

  constructor(private userDir: string = cursorUserDir()) {}

  private workspaces(): WorkspaceInfo[] {
    const wsRoot = join(this.userDir, 'workspaceStorage');
    if (!existsSync(wsRoot)) return [];
    const out: WorkspaceInfo[] = [];
    for (const hash of readdirSync(wsRoot)) {
      const wsJson = join(wsRoot, hash, 'workspace.json');
      const dbPath = join(wsRoot, hash, 'state.vscdb');
      if (!existsSync(wsJson) || !existsSync(dbPath)) continue;
      let folder: string | undefined;
      try {
        const parsed = JSON.parse(readFileSync(wsJson, 'utf8')) as { folder?: string };
        if (parsed.folder?.startsWith('file://')) folder = fileURLToPath(parsed.folder);
      } catch {
        continue;
      }
      if (!folder) continue;
      const db = openDb(dbPath);
      if (!db) continue;
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
        const data = row ? parseValue(row.value) : undefined;
        const ids = Array.isArray(data?.allComposers)
          ? data.allComposers.map((c: { composerId?: string }) => c.composerId).filter(Boolean)
          : [];
        if (ids.length > 0) out.push({ hash, path: folder, composerIds: ids });
      } catch {
        // workspace db without composer data
      } finally {
        db.close();
      }
    }
    return out;
  }

  async discover(): Promise<ObservedProject[]> {
    const projects: ObservedProject[] = [];
    const globalDb = openDb(join(this.userDir, 'globalStorage', 'state.vscdb'));
    for (const ws of this.workspaces()) {
      let lastActivity: string | undefined;
      if (globalDb) {
        for (const id of ws.composerIds) {
          try {
            const row = globalDb.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`);
            const meta = row ? parseValue(row.value) : undefined;
            const ts = meta?.lastUpdatedAt ?? meta?.createdAt;
            if (typeof ts === 'number') {
              const iso = new Date(ts).toISOString();
              if (!lastActivity || iso > lastActivity) lastActivity = iso;
            }
          } catch {
            continue;
          }
        }
      }
      projects.push({
        id: ws.hash,
        path: ws.path,
        sessionCount: ws.composerIds.length,
        lastActivity,
      });
    }
    globalDb?.close();
    projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return projects;
  }

  async observe(project: ObservedProject): Promise<Observation[]> {
    const ws = this.workspaces().find((w) => w.hash === project.id || w.path === project.path);
    if (!ws) return [];
    const db = openDb(join(this.userDir, 'globalStorage', 'state.vscdb'));
    if (!db) return [];
    const observations: Observation[] = [];
    try {
      for (const composerId of ws.composerIds) {
        const metaRow = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`);
        const meta = metaRow ? parseValue(metaRow.value) : undefined;
        if (!meta) continue;
        const headers: { bubbleId?: string; type?: number }[] = Array.isArray(meta.fullConversationHeadersOnly)
          ? meta.fullConversationHeadersOnly
          : [];
        const timestamp = new Date(typeof meta.createdAt === 'number' ? meta.createdAt : 0).toISOString();
        let lastAssistantText = '';
        let n = 0;
        for (const header of headers) {
          if (!header.bubbleId) continue;
          const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${composerId}:${header.bubbleId}`);
          const bubble = row ? parseValue(row.value) : undefined;
          if (!bubble) continue;
          n++;
          const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
          if (!text) continue;
          if (bubble.type === 2) {
            lastAssistantText = text.slice(0, 400);
            continue;
          }
          if (bubble.type !== 1 || looksLikeInjectedContent(text)) continue;
          const correction = classifyCorrection(text, {
            followsAgentActivity: lastAssistantText.length > 0,
            followsInterrupt: false,
          });
          observations.push({
            id: `${composerId}:${n}`,
            source: this.name,
            kind: correction ? 'correction' : 'instruction',
            timestamp,
            sessionId: composerId,
            text,
            agentContext: correction ? lastAssistantText || undefined : undefined,
          });
        }
      }
    } finally {
      db.close();
    }
    observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return observations;
  }
}
