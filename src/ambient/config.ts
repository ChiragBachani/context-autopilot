/**
 * Ambient observer configuration and consent state.
 *
 * Lives at ~/.ctxlayer/ambient/config.json (CTXLAYER_HOME overrides the
 * ~/.ctxlayer base — used by tests and demo mode so they never touch real
 * data). The `enabled` flag is the master OFF switch: the capture path checks
 * it before every single screenshot, so flipping it off stops a running
 * daemon instantly and survives restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AmbientConfig {
  version: 1;
  /** Master switch. false = no capture, ever, until explicitly re-enabled. */
  enabled: boolean;
  /** ISO timestamp; capture is suspended until then. */
  pausedUntil?: string;
  /** Delete each screenshot immediately after OCR (keep only text records). */
  textOnly: boolean;
  /** Screenshots older than this are deleted (text records are kept). */
  retentionDays: number;
  dashboardPort: number;
  /** Auto-distill: wait at least this long between runs (0 disables). */
  autoDistillEveryMinutes: number;
  /** Auto-distill: only run once this many new moments have been captured. */
  autoDistillMinNewMoments: number;
  /** App-name fragments that are never captured (case-insensitive). */
  blocklistApps: string[];
  /** Window-title fragments that are never captured (case-insensitive). */
  blocklistTitleKeywords: string[];
}

export const DEFAULT_CONFIG: AmbientConfig = {
  version: 1,
  enabled: true,
  textOnly: false,
  retentionDays: 14,
  dashboardPort: 4780,
  // Mine for patterns every couple of hours once enough new moments exist —
  // waiting for a nightly run makes day one feel dead.
  autoDistillEveryMinutes: 120,
  autoDistillMinNewMoments: 10,
  // Password managers and video calls are off-limits out of the box — calls
  // would capture other people's faces and screens.
  blocklistApps: [
    '1Password',
    'Keychain Access',
    'Passwords',
    'zoom.us',
    'Zoom',
    'Microsoft Teams',
    'FaceTime',
    'Webex',
  ],
  blocklistTitleKeywords: [
    'password',
    'passkey',
    'bank',
    'banking',
    'sign in',
    'log in',
    'login',
    'meet.google.com',
    'zoom.us/j/',
    'incognito',
    'private browsing',
  ],
};

/** Base data dir: ~/.ctxlayer, or $CTXLAYER_HOME (tests / demo isolation). */
export function ctxlayerHome(): string {
  return process.env.CTXLAYER_HOME ?? join(homedir(), '.ctxlayer');
}

export function ambientRoot(): string {
  return join(ctxlayerHome(), 'ambient');
}

export function aopsRoot(): string {
  return join(ctxlayerHome(), 'aops');
}

function configPath(): string {
  return join(ambientRoot(), 'config.json');
}

export function loadConfig(): AmbientConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<AmbientConfig>;
    return { ...DEFAULT_CONFIG, ...raw, version: 1 };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: AmbientConfig): void {
  mkdirSync(ambientRoot(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function configExists(): boolean {
  return existsSync(configPath());
}

/** Master switch, one flag: `ctxlayer on` / `ctxlayer off` / dashboard OFF. */
export function setEnabled(enabled: boolean): AmbientConfig {
  const config = loadConfig();
  config.enabled = enabled;
  if (enabled) delete config.pausedUntil;
  saveConfig(config);
  return config;
}

export function pauseFor(minutes: number): AmbientConfig {
  const config = loadConfig();
  config.pausedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
  saveConfig(config);
  return config;
}

export type CaptureVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'disabled' | 'paused' | 'blocklisted-app' | 'blocklisted-title' | 'blocklisted-url' };

/**
 * The gate every capture goes through. Pure, so tests can hammer it. When a
 * browser URL is known, the same title-keyword blocklist is applied to it, so
 * a sensitive page (bank, login…) is blocked even if its window title is bland.
 */
export function captureVerdict(
  config: AmbientConfig,
  app: string,
  title: string,
  now: Date = new Date(),
  url?: string,
): CaptureVerdict {
  if (!config.enabled) return { allowed: false, reason: 'disabled' };
  if (config.pausedUntil && now.toISOString() < config.pausedUntil) {
    return { allowed: false, reason: 'paused' };
  }
  const appLower = app.toLowerCase();
  for (const blocked of config.blocklistApps) {
    if (appLower.includes(blocked.toLowerCase())) return { allowed: false, reason: 'blocklisted-app' };
  }
  const titleLower = title.toLowerCase();
  for (const keyword of config.blocklistTitleKeywords) {
    if (titleLower.includes(keyword.toLowerCase())) return { allowed: false, reason: 'blocklisted-title' };
  }
  if (url) {
    const urlLower = url.toLowerCase();
    for (const keyword of config.blocklistTitleKeywords) {
      if (urlLower.includes(keyword.toLowerCase())) return { allowed: false, reason: 'blocklisted-url' };
    }
  }
  return { allowed: true };
}
