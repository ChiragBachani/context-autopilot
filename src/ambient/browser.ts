/**
 * Browser adapter: at an intentional moment, when the frontmost app is a
 * browser, read the *active tab's URL* so web work is observed as precise
 * domains/paths rather than fuzzy window titles.
 *
 * Why this matters:
 *  - "Inbox (23) - you@gmail.com - Gmail" is ambiguous; `mail.google.com/#inbox`
 *    is machine-actionable — it clusters web workflows far more reliably and
 *    carries the exact address an agent would later navigate to.
 *
 * Privacy invariants, enforced here:
 *  - Incognito / private windows return NO url (never observed).
 *  - The url is fed through the same capture gate as everything else, plus a
 *    host/path blocklist check — a blocked page is skipped before any capture.
 *  - Reading the active tab uses AppleScript (Automation), which the OS gates
 *    behind an explicit one-time per-browser consent the user grants.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AmbientConfig } from './config.js';

const execFileAsync = promisify(execFile);

/** How to ask each browser family for its active tab. */
type BrowserDialect = 'chromium' | 'safari';

/**
 * App-name fragment (case-insensitive) → AppleScript dialect. Chromium-family
 * browsers share the `active tab of front window` grammar; Safari differs.
 */
const KNOWN_BROWSERS: { match: string; dialect: BrowserDialect }[] = [
  { match: 'google chrome', dialect: 'chromium' },
  { match: 'chromium', dialect: 'chromium' },
  { match: 'brave browser', dialect: 'chromium' },
  { match: 'microsoft edge', dialect: 'chromium' },
  { match: 'arc', dialect: 'chromium' },
  { match: 'vivaldi', dialect: 'chromium' },
  { match: 'opera', dialect: 'chromium' },
  { match: 'safari', dialect: 'safari' },
];

/** The browser dialect for an app name, or undefined if it isn't a browser. */
export function browserDialect(app: string): BrowserDialect | undefined {
  const lower = app.toLowerCase();
  return KNOWN_BROWSERS.find((b) => lower.includes(b.match))?.dialect;
}

export function isBrowser(app: string): boolean {
  return browserDialect(app) !== undefined;
}

/**
 * AppleScript that returns "url\ntitle" for the active tab, or empty output
 * when the window is private/incognito or has no tab. Kept defensive: any
 * property that isn't there just yields empty.
 */
function activeTabScript(app: string, dialect: BrowserDialect): string {
  if (dialect === 'safari') {
    // Safari has no scriptable private-mode flag; a private document reports an
    // empty URL, which the caller treats as "nothing to observe".
    return [
      `tell application "${app}"`,
      '  try',
      '    set theDoc to front document',
      '    return (URL of theDoc) & "\\n" & (name of theDoc)',
      '  on error',
      '    return ""',
      '  end try',
      'end tell',
    ].join('\n');
  }
  return [
    `tell application "${app}"`,
    '  try',
    '    set w to front window',
    '    try',
    '      if (mode of w) is "incognito" then return ""',
    '    end try',
    '    set t to active tab of w',
    '    return (URL of t) & "\\n" & (title of t)',
    '  on error',
    '    return ""',
    '  end try',
    'end tell',
  ].join('\n');
}

export interface ActiveTab {
  url: string;
  title: string;
}

/**
 * Read the frontmost browser's active tab. Returns undefined when the app is
 * not a known browser, the window is private/incognito, Automation consent is
 * missing, or the tab has no real web URL (about:blank, chrome://…).
 */
export async function activeBrowserTab(app: string): Promise<ActiveTab | undefined> {
  const dialect = browserDialect(app);
  if (!dialect) return undefined;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', activeTabScript(app, dialect)], {
      timeout: 2000,
    });
    const [url = '', ...rest] = stdout.trim().split('\n');
    if (!isObservableUrl(url)) return undefined;
    return { url: url.trim(), title: rest.join(' ').trim() };
  } catch {
    // Automation denied, browser busy, or AppleScript error — degrade silently
    // to window-title-only observation (the caller keeps its existing record).
    return undefined;
  }
}

/** Only real http(s) pages are worth observing; skip internal/blank pages. */
export function isObservableUrl(url: string): boolean {
  const u = url.trim().toLowerCase();
  return u.startsWith('http://') || u.startsWith('https://');
}

/** Hostname of a URL, without a leading www. Empty string if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * A stable clustering key for a web step: host + first path segment. This is
 * what lets "Gmail → download → Sheets → send" recur across days even as query
 * strings and message ids change. e.g. https://docs.google.com/spreadsheets/d/AB…
 * → "docs.google.com/spreadsheets".
 */
export function browserStepKey(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return seg ? `${host}/${seg}` : host;
  } catch {
    return '';
  }
}

/**
 * Is this URL off-limits? Reuses the user's title-keyword blocklist against the
 * full URL (so "bank", "login", etc. catch sensitive pages), plus a check on
 * the bare host. Pure, so tests can hammer it.
 */
export function urlBlocked(config: AmbientConfig, url: string): boolean {
  const haystack = url.toLowerCase();
  const host = hostOf(url);
  return config.blocklistTitleKeywords.some((kw) => {
    const k = kw.toLowerCase();
    return haystack.includes(k) || host.includes(k);
  });
}
