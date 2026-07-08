/**
 * Day summary: turn the dense activity log into an at-a-glance picture of the
 * day's work — even when nothing recurred often enough to be a workflow yet.
 * This is the "prove it's working" surface: where your time went, how focused
 * you were, what you touched. The stats are pure and instant; an optional
 * model narrative turns them into a plain-English recap.
 */

import { runModel } from '../distill.js';
import { hostOf } from './browser.js';
import { readDay, readDaySegments, type ActivityRecord, type ActivitySegment } from './records.js';

export interface AppUsage {
  app: string;
  seconds: number;
  activeSeconds: number;
}

export interface SiteUsage {
  host: string;
  seconds: number;
}

export interface DaySummary {
  day: string;
  firstStart?: string;
  lastEnd?: string;
  /** Wall-clock seconds across all segments. */
  totalSeconds: number;
  /** Of those, seconds actively at the machine. */
  activeSeconds: number;
  segmentCount: number;
  keys: number;
  clicks: number;
  /** Apps by active time, richest first. */
  apps: AppUsage[];
  /** Web hosts by time, richest first. */
  sites: SiteUsage[];
  /** Local hour (0–23) with the most active time. */
  busiestHour?: { hour: number; activeSeconds: number };
}

const MAX_APPS = 8;
const MAX_SITES = 6;

/** Aggregate a day's segments into a summary. Pure — no model, instant. */
export function summarizeDay(day: string, segments: ActivitySegment[]): DaySummary {
  const apps = new Map<string, { seconds: number; activeSeconds: number }>();
  const sites = new Map<string, number>();
  const hourActive = new Array<number>(24).fill(0);
  let totalSeconds = 0;
  let activeSeconds = 0;
  let keys = 0;
  let clicks = 0;
  let firstStart: string | undefined;
  let lastEnd: string | undefined;

  for (const s of segments) {
    totalSeconds += s.seconds;
    activeSeconds += s.activeSeconds;
    keys += s.keys;
    clicks += s.clicks;
    if (!firstStart || s.start < firstStart) firstStart = s.start;
    if (!lastEnd || s.end > lastEnd) lastEnd = s.end;

    const a = apps.get(s.app) ?? { seconds: 0, activeSeconds: 0 };
    a.seconds += s.seconds;
    a.activeSeconds += s.activeSeconds;
    apps.set(s.app, a);

    if (s.url) {
      const host = hostOf(s.url);
      if (host) sites.set(host, (sites.get(host) ?? 0) + s.seconds);
    }
    const hour = new Date(s.start).getHours();
    if (hour >= 0 && hour < 24) hourActive[hour] += s.activeSeconds;
  }

  const appList: AppUsage[] = [...apps.entries()]
    .map(([app, v]) => ({ app, seconds: v.seconds, activeSeconds: v.activeSeconds }))
    .sort((x, y) => y.activeSeconds - x.activeSeconds || y.seconds - x.seconds)
    .slice(0, MAX_APPS);
  const siteList: SiteUsage[] = [...sites.entries()]
    .map(([host, seconds]) => ({ host, seconds }))
    .sort((x, y) => y.seconds - x.seconds)
    .slice(0, MAX_SITES);

  let busiestHour: DaySummary['busiestHour'];
  const peak = hourActive.reduce((best, sec, hour) => (sec > best.sec ? { hour, sec } : best), { hour: -1, sec: 0 });
  if (peak.hour >= 0 && peak.sec > 0) busiestHour = { hour: peak.hour, activeSeconds: peak.sec };

  return {
    day,
    firstStart,
    lastEnd,
    totalSeconds,
    activeSeconds,
    segmentCount: segments.length,
    keys,
    clicks,
    apps: appList,
    sites: siteList,
    busiestHour,
  };
}

/** Convenience: summarize a day straight from disk. */
export function summarizeDayFromDisk(day: string): DaySummary {
  return summarizeDay(day, readDaySegments(day));
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function hour12(h: number): string {
  const period = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${period}`;
}

/** A plain-text digest for the terminal. */
export function renderSummaryText(s: DaySummary): string {
  if (s.segmentCount === 0) return `No activity recorded for ${s.day} yet.`;
  const lines: string[] = [];
  const span = s.firstStart && s.lastEnd ? `${hour12(new Date(s.firstStart).getHours())}–${hour12(new Date(s.lastEnd).getHours())}` : '';
  lines.push(`Your day — ${s.day}${span ? ` (${span})` : ''}`);
  lines.push(`  Active: ${formatDuration(s.activeSeconds)} of ${formatDuration(s.totalSeconds)} observed · ${s.keys.toLocaleString()} keystrokes · ${s.clicks.toLocaleString()} clicks`);
  if (s.busiestHour) lines.push(`  Busiest hour: ${hour12(s.busiestHour.hour)} (${formatDuration(s.busiestHour.activeSeconds)} active)`);
  lines.push('  Where your time went:');
  for (const a of s.apps) lines.push(`    · ${a.app.padEnd(22)} ${formatDuration(a.activeSeconds)}`);
  if (s.sites.length) {
    lines.push('  Top sites:');
    for (const site of s.sites) lines.push(`    · ${site.host.padEnd(28)} ${formatDuration(site.seconds)}`);
  }
  return lines.join('\n');
}

export interface NarrateOptions {
  model?: string;
  runModel?: (prompt: string, model?: string) => Promise<string>;
}

/** Keep the evidence log inside a sane prompt budget. */
const EVIDENCE_MAX_LINES = 120;
const EVIDENCE_MAX_CHARS = 14_000;
const EVIDENCE_OCR_CLIP = 220;

/**
 * A compact, chronological log of what was actually on screen: activity
 * segments (app, window title, url, time spent) interleaved with the OCR
 * digests of captured moments. This is what lets the recap say "you drafted a
 * Reddit post about your MCP launch" instead of "you used Chrome for 11m".
 * Long days are thinned evenly rather than truncated at noon.
 */
export function buildDayEvidence(
  segments: ActivitySegment[],
  records: ActivityRecord[],
): string {
  interface Line {
    at: string;
    text: string;
  }
  const lines: Line[] = [];
  for (const s of segments) {
    // Sub-flicker context changes add noise, not story.
    if (s.seconds < 10) continue;
    const when = `${s.start.slice(11, 16)}–${s.end.slice(11, 16)}`;
    const where = s.url ? ` <${s.url}>` : '';
    const cadence = s.keys > 30 ? `, typing (${s.keys} keys)` : '';
    lines.push({
      at: s.start,
      text: `${when} [${s.app}]${where} "${s.windowTitle}" — ${formatDuration(s.activeSeconds)} active${cadence}`,
    });
  }
  for (const r of records) {
    if (!r.text) continue;
    const digest = r.text.replace(/\s+/g, ' ').slice(0, EVIDENCE_OCR_CLIP);
    const where = r.url ? ` <${r.url}>` : '';
    lines.push({
      at: r.timestamp,
      text: `${r.timestamp.slice(11, 16)} [${r.app}]${where} screen showed: "${digest}"`,
    });
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));

  // Thin evenly so morning and evening both survive the budget.
  let kept = lines;
  if (kept.length > EVIDENCE_MAX_LINES) {
    const step = kept.length / EVIDENCE_MAX_LINES;
    kept = Array.from({ length: EVIDENCE_MAX_LINES }, (_, i) => kept[Math.floor(i * step)]);
  }
  let out = kept.map((l) => l.text).join('\n');
  if (out.length > EVIDENCE_MAX_CHARS) out = out.slice(0, EVIDENCE_MAX_CHARS) + '…';
  return out;
}

/**
 * Turn the day into a plain-English recap via the user's own model — grounded
 * in what was actually on screen (window titles, URLs, on-device OCR excerpts),
 * so it can name the post you wrote and the file you pulled from. Raw
 * screenshots and keystroke content never leave the machine; this sends the
 * same kind of extracted text excerpts the workflow distiller already uses.
 */
export async function narrateDay(summary: DaySummary, opts: NarrateOptions = {}): Promise<string> {
  if (summary.segmentCount === 0) return 'Nothing observed yet today — the recap fills in as you work.';
  const call = opts.runModel ?? runModel;
  const facts = {
    day: summary.day,
    activeTime: formatDuration(summary.activeSeconds),
    observedTime: formatDuration(summary.totalSeconds),
    keystrokes: summary.keys,
    clicks: summary.clicks,
    busiestHour: summary.busiestHour ? `${summary.busiestHour.hour}:00` : undefined,
    apps: summary.apps.map((a) => ({ app: a.app, active: formatDuration(a.activeSeconds) })),
    sites: summary.sites.map((s) => ({ host: s.host, time: formatDuration(s.seconds) })),
  };
  const evidence = buildDayEvidence(readDaySegments(summary.day), readDay(summary.day));
  const prompt = `You are recapping one person's work day from ambient observation: a chronological evidence log (window titles, URLs, durations, and text that was visibly on screen) plus aggregate stats. Write a specific, concrete recap of WHAT THEY ACTUALLY DID, in 3–6 sentences.

Rules:
- Name the actual things: the post they drafted and where, the document/file they read or edited, the site and what they did there — pull these from the window titles, URLs, and on-screen text.
- Tell it roughly in order ("you started with…, then…").
- Prefer specifics over categories: "drafted a Reddit post in r/ClaudeAI about the Context Autopilot launch" beats "browsed Reddit".
- If the evidence is thin for a stretch, say what's visible without inventing detail. Never fabricate names or tasks the evidence doesn't support.
- End with one honest observation about the shape of the day (focus, switching, a theme).
- No preamble, no bullet points — just the recap, addressed as "you".

## Evidence log (chronological)
${evidence || '(no on-screen evidence captured yet)'}

## Aggregate stats (JSON)
${JSON.stringify(facts, null, 2)}`;
  const out = await call(prompt, opts.model);
  return out.trim();
}
