/**
 * Activity records: what the ambient observer saw, one JSONL file per day at
 * ~/.ctxlayer/ambient/YYYY-MM-DD/records.jsonl, screenshots beside it. Text
 * records are tiny and kept forever; screenshots age out per retention config.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ambientRoot } from './config.js';

export type CaptureTrigger = 'burst-end' | 'dwell' | 'context-switch' | 'new-page' | 'demo';

export interface ActivityRecord {
  id: string;
  /** ISO 8601. */
  timestamp: string;
  app: string;
  windowTitle: string;
  trigger: CaptureTrigger;
  /** App the user came from (context-switch records). */
  fromApp?: string;
  /** Screenshot path relative to the ambient root, if one was kept. */
  screenshot?: string;
  /** On-device OCR extract, clipped. Absent when OCR was unavailable. */
  text?: string;
  /** Active-tab URL when the app was a browser (never set for private tabs). */
  url?: string;
}

/**
 * A stretch of continuous work in one app/window — the dense activity log that
 * powers the day summary. Sampled every observer tick (cheap: app/window + an
 * idle-time and keystroke-COUNT reading), so a day is thousands of data points,
 * not the handful of screenshots. Stored per day at
 * ~/.ctxlayer/ambient/YYYY-MM-DD/activity.jsonl, separate from screenshots.
 */
export interface ActivitySegment {
  app: string;
  windowTitle: string;
  /** Active-tab URL when the app was a browser. */
  url?: string;
  /** ISO 8601. */
  start: string;
  end: string;
  /** Wall-clock seconds spent in this segment. */
  seconds: number;
  /** Of those, seconds the user was actively at the machine (not idle). */
  activeSeconds: number;
  /** Key-downs during the segment (COUNT only — never content). */
  keys: number;
  /** Mouse clicks during the segment. */
  clicks: number;
}

export function appendSegment(segment: ActivitySegment): void {
  // Bucket by LOCAL day — readers use dayKey(), and an evening's work must
  // land in "today", not tomorrow's UTC date.
  const day = dayKey(new Date(segment.start));
  const dir = dayDir(day);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'activity.jsonl'), JSON.stringify(segment) + '\n', 'utf8');
}

export function readDaySegments(day: string): ActivitySegment[] {
  const path = join(dayDir(day), 'activity.jsonl');
  if (!existsSync(path)) return [];
  const segments: ActivitySegment[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      segments.push(JSON.parse(line) as ActivitySegment);
    } catch {
      continue;
    }
  }
  segments.sort((a, b) => a.start.localeCompare(b.start));
  return segments;
}

export function dayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayDir(day: string): string {
  return join(ambientRoot(), day);
}

export function appendRecord(record: ActivityRecord): void {
  // Bucket by LOCAL day (see appendSegment) — before this, records written
  // after 5pm Pacific landed in tomorrow's UTC folder and vanished from
  // "today" everywhere.
  const day = dayKey(new Date(record.timestamp));
  const dir = dayDir(day);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'records.jsonl'), JSON.stringify(record) + '\n', 'utf8');
}

export function readDay(day: string): ActivityRecord[] {
  const path = join(dayDir(day), 'records.jsonl');
  if (!existsSync(path)) return [];
  const records: ActivityRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ActivityRecord);
    } catch {
      continue;
    }
  }
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return records;
}

/** Observed days, newest first. */
export function listDays(): string[] {
  const root = ambientRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && existsSync(join(root, name, 'records.jsonl')))
    .sort()
    .reverse();
}

export function readAllDays(): Map<string, ActivityRecord[]> {
  const byDay = new Map<string, ActivityRecord[]>();
  for (const day of listDays()) byDay.set(day, readDay(day));
  return byDay;
}

/** Days whose screenshots have outlived the retention window. */
export function daysPastRetention(retentionDays: number, now: Date = new Date()): string[] {
  const cutoff = dayKey(new Date(now.getTime() - retentionDays * 86_400_000));
  return listDays().filter((day) => day < cutoff);
}

/** Delete screenshots for a day, keeping the text records. */
export function pruneDayScreenshots(day: string): number {
  const dir = dayDir(day);
  if (!existsSync(dir)) return 0;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.jpg') || name.endsWith('.png')) {
      rmSync(join(dir, name), { force: true });
      pruned++;
    }
  }
  return pruned;
}

/** Wipe captured data. 'today' removes today's dir; 'all' removes every day dir. */
export function deleteCapturedData(scope: 'today' | 'all'): number {
  const days = scope === 'today' ? [dayKey()] : listDays();
  let removed = 0;
  for (const day of days) {
    const dir = dayDir(day);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Rough "time observed" estimate: gaps ≤5 min between records count as active time. */
export function estimateObservedMinutes(records: ActivityRecord[]): number {
  if (records.length < 2) return records.length;
  let ms = 0;
  for (let i = 1; i < records.length; i++) {
    const gap = Date.parse(records[i].timestamp) - Date.parse(records[i - 1].timestamp);
    if (gap > 0 && gap <= 5 * 60_000) ms += gap;
  }
  return Math.round(ms / 60_000);
}

let counter = 0;
export function newRecordId(now: Date = new Date()): string {
  counter = (counter + 1) % 1000;
  return `${now.getTime().toString(36)}-${counter.toString(36)}`;
}

export function screenshotStats(): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const day of listDays()) {
    const dir = dayDir(day);
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jpg') || name.endsWith('.png')) {
        count++;
        try {
          bytes += statSync(join(dir, name)).size;
        } catch {
          // file raced away; fine
        }
      }
    }
  }
  return { count, bytes };
}
