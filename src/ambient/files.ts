/**
 * File-system sense: watch the user's working folders (Desktop, Documents,
 * Downloads by default) and record when they save or create a file — "you
 * saved invoice.pdf" is a high-signal, cheap moment that OCR alone misses.
 *
 * fs.watch is recursive on macOS. We debounce per path (editors fire many
 * events per save), cap the rate, and ignore the usual noise (dotfiles,
 * caches, node_modules, temp files). 100% local; only paths are recorded,
 * never file contents.
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename } from 'node:path';
import { appendFileEvent } from './records.js';

const DEBOUNCE_MS = 5000;
const MAX_EVENTS_PER_MIN = 60;

/** Noise we never record: hidden files, caches, build output, temp/lock files. */
export function isIgnoredPath(path: string): boolean {
  const p = path.toLowerCase();
  if (/(^|\/)\.[^/]/.test(path)) return true; // any dotfile/dotdir segment
  if (/(node_modules|\/library\/|\/caches?\/|\.git\/|dist\/|build\/|\.next\/)/.test(p)) return true;
  const base = basename(path);
  if (base.startsWith('~$') || base.endsWith('.tmp') || base.endsWith('.crdownload') || base.endsWith('.download')) return true;
  if (base.endsWith('.part') || base.endsWith('.swp') || base === '.ds_store') return true;
  return false;
}

export class FileWatcher {
  private watchers: FSWatcher[] = [];
  private lastByPath = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;

  constructor(private onEvent: (path: string) => void = (p) => this.record(p)) {}

  start(dirs: string[]): void {
    this.stop();
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: true, persistent: false }, (_type, filename) => {
          if (!filename) return;
          const full = `${dir}/${filename}`;
          this.consider(full);
        });
        this.watchers.push(w);
      } catch {
        // directory missing or unwatchable — skip it, keep the rest
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers = [];
  }

  /** Debounce + rate-limit + filter, then emit. Pure-ish (uses clock). */
  private consider(path: string, now: number = Date.now()): void {
    if (isIgnoredPath(path)) return;
    const last = this.lastByPath.get(path);
    if (last !== undefined && now - last < DEBOUNCE_MS) return;
    this.lastByPath.set(path, now);

    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= MAX_EVENTS_PER_MIN) return;
    this.windowCount++;
    this.onEvent(path);
  }

  private record(path: string): void {
    appendFileEvent({ timestamp: new Date().toISOString(), path, kind: 'saved' });
  }

  /** Exposed for tests: run the filter/debounce logic without real fs.watch. */
  test_consider(path: string, now: number): boolean {
    const before = this.windowCount;
    let emitted = false;
    const orig = this.onEvent;
    this.onEvent = () => {
      emitted = true;
    };
    this.consider(path, now);
    this.onEvent = orig;
    void before;
    return emitted;
  }
}
