/**
 * Weekly digest: a Sunday-evening 7-day narrative with trends. The daily recap
 * proves the observe→summarize pipeline; this is the version worth screenshotting.
 *
 * Structure mirrors the daily recap: pure-math aggregates (per-day active
 * minutes, top apps, automation runs, trend vs the prior week) feed the model,
 * which narrates. Persisted per ISO week so it generates once.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ambientRoot } from './config.js';
import { dayKey, readDaySegments } from './records.js';
import { readRuns } from './runner.js';
import { formatDuration, loadRecap, summarizeDay, type NarrateOptions } from './summarize.js';
import { runModel } from '../distill.js';

export interface DayRollup {
  day: string;
  activeSeconds: number;
  topApp?: string;
}

export interface WeekStats {
  startDay: string;
  endDay: string;
  days: DayRollup[];
  totalActiveSeconds: number;
  /** Apps by active time across the week. */
  topApps: { app: string; activeSeconds: number }[];
  automationRuns: number;
  /** Prior week's total active seconds, for the trend. */
  priorActiveSeconds: number;
}

/** The 7 calendar days ending on endDay (inclusive), oldest→newest. */
export function weekDays(endDay: string): string[] {
  const end = new Date(`${endDay}T12:00:00Z`);
  const out: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86_400_000);
    out.push(dayKey(d));
  }
  return out;
}

/** Pure aggregation over a week (+ the prior week's active total for trend). */
export function buildWeekStats(endDay: string): WeekStats {
  const days = weekDays(endDay);
  const rollups: DayRollup[] = [];
  const apps = new Map<string, number>();
  let totalActive = 0;

  for (const day of days) {
    const summary = summarizeDay(day, readDaySegments(day));
    totalActive += summary.activeSeconds;
    for (const a of summary.apps) apps.set(a.app, (apps.get(a.app) ?? 0) + a.activeSeconds);
    rollups.push({ day, activeSeconds: summary.activeSeconds, topApp: summary.apps[0]?.app });
  }

  let priorActive = 0;
  const dayBeforeWeek = dayKey(new Date(new Date(`${days[0]}T12:00:00Z`).getTime() - 86_400_000));
  for (const day of weekDays(dayBeforeWeek)) {
    priorActive += summarizeDay(day, readDaySegments(day)).activeSeconds;
  }

  const topApps = [...apps.entries()]
    .map(([app, activeSeconds]) => ({ app, activeSeconds }))
    .sort((a, b) => b.activeSeconds - a.activeSeconds)
    .slice(0, 6);

  const automationRuns = readRuns().filter((r) => r.startedAt.slice(0, 10) >= days[0] && r.startedAt.slice(0, 10) <= days[6]).length;

  return {
    startDay: days[0],
    endDay: days[6],
    days: rollups,
    totalActiveSeconds: totalActive,
    topApps,
    automationRuns,
    priorActiveSeconds: priorActive,
  };
}

export interface StoredDigest {
  isoWeek: string;
  startDay: string;
  endDay: string;
  generatedAt: string;
  narrative: string;
  stats: WeekStats;
}

/** ISO week key like 2026-W28 — stable id for "generate once". */
export function isoWeekKey(endDay: string): string {
  const d = new Date(`${endDay}T12:00:00Z`);
  const target = new Date(d);
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weeklyDir(): string {
  return join(ambientRoot(), 'weekly');
}

function digestPath(isoWeek: string): string {
  return join(weeklyDir(), `${isoWeek}.json`);
}

export function loadDigest(endDay: string): StoredDigest | undefined {
  const path = digestPath(isoWeekKey(endDay));
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredDigest;
  } catch {
    return undefined;
  }
}

function buildWeekPrompt(stats: WeekStats, dailyRecaps: string[]): string {
  const perDay = stats.days
    .map((d) => `  ${d.day}: ${formatDuration(d.activeSeconds)} active${d.topApp ? ` (mostly ${d.topApp})` : ''}`)
    .join('\n');
  const apps = stats.topApps.map((a) => `${a.app} ${formatDuration(a.activeSeconds)}`).join(', ');
  const trendPct =
    stats.priorActiveSeconds > 0
      ? Math.round(((stats.totalActiveSeconds - stats.priorActiveSeconds) / stats.priorActiveSeconds) * 100)
      : null;
  const recaps = dailyRecaps.length ? dailyRecaps.map((r, i) => `Day ${i + 1}: ${r}`).join('\n') : '(no daily recaps saved)';

  return `You are writing a warm, specific weekly work review from ambient observation of one person's ${stats.startDay} to ${stats.endDay}. Use the daily recaps to say what they actually worked on across the week; use the numbers for shape and trend. 4–7 sentences. Call out the main threads of work, how the week was distributed, one trend (busier/lighter than last week, a shift in focus), and end on a forward-looking note. No preamble, no bullets — just the review, addressed as "you".

## Per-day active time
${perDay}

## Top apps this week
${apps || '(none)'}

## Trend
This week active: ${formatDuration(stats.totalActiveSeconds)}; last week: ${formatDuration(stats.priorActiveSeconds)}${trendPct !== null ? ` (${trendPct >= 0 ? '+' : ''}${trendPct}%)` : ''}.
Automations run this week: ${stats.automationRuns}.

## Daily recaps (what actually happened)
${recaps}`;
}

/** Generate + persist the weekly digest. Returns undefined if the week is empty. */
export async function generateWeeklyDigest(endDay: string, opts: NarrateOptions = {}): Promise<StoredDigest | undefined> {
  const stats = buildWeekStats(endDay);
  if (stats.totalActiveSeconds === 0) return undefined;
  const dailyRecaps = stats.days.map((d) => loadRecap(d.day)?.narrative).filter((n): n is string => !!n);
  const call = opts.runModel ?? runModel;
  const narrative = (await call(buildWeekPrompt(stats, dailyRecaps), opts.model)).trim();
  if (!narrative) return undefined;
  const digest: StoredDigest = {
    isoWeek: isoWeekKey(endDay),
    startDay: stats.startDay,
    endDay: stats.endDay,
    generatedAt: new Date().toISOString(),
    narrative,
    stats,
  };
  mkdirSync(weeklyDir(), { recursive: true });
  writeFileSync(digestPath(digest.isoWeek), JSON.stringify(digest, null, 2) + '\n', 'utf8');
  return digest;
}
