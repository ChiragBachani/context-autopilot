/**
 * Ask: intent-level questions about your own activity, answered in natural
 * language — "what was I trying to achieve this morning, and did I solve it
 * by the afternoon?" — with an assist loop: when the answer identifies an
 * unfinished goal, it can hand that goal (plus everything already tried) to a
 * live Claude session.
 *
 * Pipeline: parse the question's time spans + terms locally (pure functions)
 * → assemble an evidence pack weighted toward deep chronological trails for
 * the referenced spans → ONE grounded model call that interprets (infers
 * goals, judges resolution) rather than summarizes → structured output with
 * an optional handoff.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runModel } from '../distill.js';
import { ctxlayerHome } from './config.js';
import { dayKey, readDay, readDaySegments } from './records.js';
import { readRuns } from './runner.js';
import { searchHistory, type SearchHit } from './search.js';
import { buildDayEvidence, formatDuration, loadRecap, summarizeDayFromDisk } from './summarize.js';

// ---------------------------------------------------------------------------
// Question parsing (pure)

export interface TimeSpan {
  day: string;
  /** Local hours, inclusive start / exclusive end. Absent = the whole day. */
  startHour?: number;
  endHour?: number;
  label: string;
}

const PART_OF_DAY: [RegExp, number, number, string][] = [
  [/\bmornings?\b/i, 5, 12, 'morning'],
  [/\bafternoons?\b/i, 12, 18, 'afternoon'],
  [/\bevenings?\b|\btonight\b|\bnights?\b/i, 18, 24, 'evening'],
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function shiftDay(now: Date, deltaDays: number): string {
  return dayKey(new Date(now.getTime() + deltaDays * 86_400_000));
}

/** Days the question refers to (no part-of-day yet). Empty = unspecified. */
function dayWords(question: string, now: Date): { day: string; word: string }[] {
  const q = question.toLowerCase();
  const days: { day: string; word: string }[] = [];
  if (/\btoday\b|\bthis morning\b|\bthis afternoon\b|\bthis evening\b|\btonight\b/.test(q)) {
    days.push({ day: dayKey(now), word: 'today' });
  }
  if (/\byesterday\b/.test(q)) days.push({ day: shiftDay(now, -1), word: 'yesterday' });
  for (let d = 0; d < 7; d++) {
    const name = WEEKDAYS[d];
    if (!new RegExp(`\\b${name}\\b`, 'i').test(q)) continue;
    // "Monday" = the most recent past Monday; "last Monday" = one week further
    // back when today IS that weekday (otherwise the same most-recent one).
    let delta = now.getDay() - d;
    if (delta <= 0) delta += 7;
    if (new RegExp(`\\blast\\s+${name}\\b`, 'i').test(q) && delta === 7) delta = 7;
    days.push({ day: shiftDay(now, -delta), word: name });
  }
  // "July 8" / "July 8th"
  for (let m = 0; m < 12; m++) {
    const re = new RegExp(`\\b${MONTHS[m]}\\s+(\\d{1,2})`, 'i');
    const hit = re.exec(q);
    if (hit) {
      const year = now.getFullYear();
      const d = new Date(year, m, Number(hit[1]));
      if (d.getTime() > now.getTime()) d.setFullYear(year - 1); // "December 30" in January = last year
      days.push({ day: dayKey(d), word: hit[0] });
    }
  }
  const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) days.push({ day: iso[1], word: iso[1] });
  if (/\bthis week\b/.test(q)) {
    for (let i = now.getDay(); i >= 0; i--) days.push({ day: shiftDay(now, -i), word: 'this week' });
  }
  // Dedupe, keep order.
  const seen = new Set<string>();
  return days.filter((d) => (seen.has(d.day) ? false : (seen.add(d.day), true)));
}

/**
 * The question's referenced time spans: day × part-of-day. Defaults to today
 * when nothing is referenced. Capped to 6 spans.
 */
export function dayRefsFromQuestion(question: string, now: Date = new Date()): TimeSpan[] {
  const days = dayWords(question, now);
  const parts = PART_OF_DAY.filter(([re]) => re.test(question));
  const baseDays = days.length ? days : [{ day: dayKey(now), word: 'today' }];
  const spans: TimeSpan[] = [];
  for (const { day, word } of baseDays) {
    if (parts.length === 0) {
      spans.push({ day, label: word });
    } else {
      for (const [, start, end, name] of parts) {
        spans.push({ day, startHour: start, endHour: end, label: `${word} ${name}` });
      }
    }
  }
  return spans.slice(0, 6);
}

/** Did the question name a specific day / part-of-day at all? */
export function hasExplicitTimeRef(question: string, now: Date = new Date()): boolean {
  return dayWords(question, now).length > 0 || PART_OF_DAY.some(([re]) => re.test(question));
}

/** How many recent days to trail-scan when the question names no specific day. */
const DEFAULT_LOOKBACK_DAYS = 4;

/**
 * The spans to actually mine for a question. When a day/time is named, use it
 * (deep). When NOT — e.g. "what didn't I finish?" — a single day is too
 * narrow; scan the last few days so unfinished work from earlier surfaces.
 */
export function resolveSpans(question: string, now: Date = new Date()): TimeSpan[] {
  if (hasExplicitTimeRef(question, now)) return dayRefsFromQuestion(question, now);
  const spans: TimeSpan[] = [];
  for (let i = 0; i < DEFAULT_LOOKBACK_DAYS; i++) {
    spans.push({ day: shiftDay(now, -i), label: i === 0 ? 'today' : i === 1 ? 'yesterday' : `${i} days ago` });
  }
  return spans;
}

const STOPWORDS = new Set(
  'the a an and or but if then was were is are am be been did do does what when where which who whom why how i me my you your it its this that these those with without about across into onto from for of on in at by to trying try achieve achieved solve solved help think know tell can could would should have had has get got today yesterday morning afternoon evening tonight week day days last will just like really them they were-was'.split(
    /\s+/,
  ),
);

/** Meaningful lookup terms from the question (for searchHistory). */
export function extractSearchTerms(question: string): string[] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9.-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !WEEKDAYS.includes(w) && !MONTHS.includes(w));
  return [...new Set(terms)].slice(0, 6);
}

// ---------------------------------------------------------------------------
// Evidence assembly

const EVIDENCE_CAP = 22_000;
/** Total trail lines shared across all spans (so a 4-day scan stays bounded). */
const TRAIL_LINE_BUDGET = 90;
/** Recaps to include — the multi-day narrative for "what did I not finish?". */
const RECAP_LOOKBACK_DAYS = 10;

export interface AskEvidence {
  text: string;
  hits: SearchHit[];
}

function inSpan(ts: string, span: TimeSpan): boolean {
  if (span.startHour === undefined || span.endHour === undefined) return true;
  const hour = new Date(ts).getHours(); // local, matching the user's mental model
  return hour >= span.startHour && hour < span.endHour;
}

export function buildAskEvidence(spans: TimeSpan[], terms: string[], now: Date = new Date()): AskEvidence {
  const sections: string[] = [];

  // 1. Deep chronological trail per referenced span — where intent lives.
  // The line budget is shared across spans, so scanning several days for an
  // unfinished-work question stays within the prompt budget.
  const perSpanLines = Math.max(20, Math.floor(TRAIL_LINE_BUDGET / Math.max(1, spans.length)));
  for (const span of spans) {
    const segments = readDaySegments(span.day).filter((s) => inSpan(s.start, span));
    const records = readDay(span.day).filter((r) => inSpan(r.timestamp, span));
    const trail = buildDayEvidence(segments, records).split('\n').slice(0, perSpanLines).join('\n');
    if (trail) sections.push(`## Activity trail — ${span.day} (${span.label})\n${trail}`);
  }

  // 2. Entity lookups across all history (OCR, titles, URLs, files, clipboard).
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    for (const h of searchHistory(term, { limit: 10 })) {
      const key = `${h.day}|${h.timestamp}|${h.app}|${h.matched}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  }
  hits.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const hitLines = hits
    .slice(0, 25)
    .map((h) => `  ${h.day} ${h.timestamp.slice(11, 16)} [${h.app}] ${h.windowTitle.slice(0, 60)}${h.snippet ? ` — "${h.snippet.slice(0, 100)}"` : ''}`);
  if (hitLines.length) sections.push(`## Matches for ${terms.map((t) => `"${t}"`).join(', ')}\n${hitLines.join('\n')}`);

  // 3. Light footer: two-week shape, recaps for the spans' days, run receipts.
  const statLines: string[] = [];
  for (let i = 0; i < 14; i++) {
    const day = shiftDay(now, -i);
    const s = summarizeDayFromDisk(day);
    if (s.segmentCount === 0) continue;
    const apps = s.apps.slice(0, 3).map((a) => `${a.app} ${formatDuration(a.activeSeconds)}`).join(', ');
    statLines.push(`  ${day}: ${formatDuration(s.activeSeconds)} active — ${apps}`);
  }
  if (statLines.length) sections.push(`## Daily shape (last 14 days)\n${statLines.join('\n')}`);

  // Recaps across a rolling window (not just the referenced days) — these are
  // the day-by-day narratives that reveal what was finished vs left hanging
  // over the past days.
  const recapDays = new Set<string>([...spans.map((s) => s.day)]);
  for (let i = 0; i < RECAP_LOOKBACK_DAYS; i++) recapDays.add(shiftDay(now, -i));
  const recaps = [...recapDays]
    .sort()
    .reverse()
    .map((day) => ({ day, recap: loadRecap(day) }))
    .filter((r) => r.recap)
    .map((r) => `  ${r.day}: ${r.recap!.narrative.slice(0, 320)}`);
  if (recaps.length) sections.push(`## Day-by-day recaps (recent)\n${recaps.join('\n')}`);

  const runs = readRuns()
    .slice(0, 8)
    .map((r) => `  ${r.startedAt.slice(0, 16).replace('T', ' ')} ${r.slug} ${r.exitCode === 0 ? '✓' : r.finishedAt ? '✗' : '…'}${r.summary ? ` — ${r.summary.slice(0, 120)}` : ''}`);
  if (runs.length) sections.push(`## Automation runs\n${runs.join('\n')}`);

  let text = sections.join('\n\n');
  if (text.length > EVIDENCE_CAP) text = text.slice(0, EVIDENCE_CAP) + '\n…(evidence truncated)';
  return { text, hits: hits.slice(0, 25) };
}

// ---------------------------------------------------------------------------
// The ask itself

export interface AskTurn {
  q: string;
  a: string;
}

export interface AskHandoff {
  goal: string;
  context: string;
}

export interface AskResult {
  answer: string;
  hits: SearchHit[];
  handoff?: AskHandoff & { id: string };
}

export interface AskOptions {
  model?: string;
  runModel?: (prompt: string, model?: string) => Promise<string>;
  now?: Date;
}

export function buildAskPrompt(question: string, history: AskTurn[], evidence: string, now: Date): string {
  const past = history
    .slice(-3)
    .map((t) => `User asked: ${t.q}\nYou answered: ${t.a.slice(0, 500)}`)
    .join('\n\n');
  return `You are the user's ambient activity companion. Below is REAL observed evidence from their computer (window titles, URLs, on-screen text, typing bursts, file saves, clipboard, in chronological order). Answer their question by INTERPRETING the evidence, not summarizing it.

How to interpret:
- Infer what they were TRYING TO ACHIEVE from behavior: searches typed, error text on screen, docs opened, the sequence of apps. State your reasoning briefly ("you searched X, then opened Y — you were working on…").
- If asked whether something got solved/finished, compare the relevant time spans and give a verdict — solved / not solved / unclear — WITH the evidence for it (e.g. "the error stops appearing after 14:32" or "the last trace at 11:50 still shows the failing state").
- Ground every claim in the evidence; cite day + time. If the trail doesn't show something, say so plainly — never invent.
- The evidence may span SEVERAL days (activity trails + day-by-day recaps). For "what didn't I finish / what's left" questions, look ACROSS all the days shown, not just the most recent — unfinished work often started days ago. Attribute each thread to its day(s).
- Current date/time: ${now.toString()}. Be concise and plain-spoken; 1-3 short paragraphs.

Output format — respond with ONLY a JSON object (no fence, no prose outside it):
{"answer": "<your answer, plain text>", "handoff": {"goal": "<short imperative goal>", "context": "<what they already tried, where it stalled, key links/files/errors from the evidence>"}}
Include "handoff" ONLY when the evidence shows a concrete unfinished goal AND the user asked for (or clearly implied wanting) help finishing it. Otherwise omit the handoff key entirely.

${past ? `## Earlier in this conversation\n${past}\n\n` : ''}## Evidence
${evidence}

## Question
${question}`;
}

/** Lenient parse: JSON object with an answer; malformed → raw text answer. */
export function parseAskResponse(raw: string): { answer: string; handoff?: AskHandoff } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { answer?: unknown; handoff?: { goal?: unknown; context?: unknown } };
      if (typeof obj.answer === 'string' && obj.answer.trim()) {
        const handoff =
          obj.handoff && typeof obj.handoff.goal === 'string' && obj.handoff.goal.trim()
            ? { goal: obj.handoff.goal.trim(), context: typeof obj.handoff.context === 'string' ? obj.handoff.context : '' }
            : undefined;
        return { answer: obj.answer.trim(), handoff };
      }
    } catch {
      // fall through to raw
    }
  }
  return { answer: raw.trim() };
}

export async function askActivity(question: string, history: AskTurn[] = [], opts: AskOptions = {}): Promise<AskResult> {
  const now = opts.now ?? new Date();
  const spans = resolveSpans(question, now);
  const terms = extractSearchTerms(question);
  const evidence = buildAskEvidence(spans, terms, now);
  const call = opts.runModel ?? runModel;
  const raw = await call(buildAskPrompt(question, history, evidence.text, now), opts.model);
  const parsed = parseAskResponse(raw);
  const result: AskResult = { answer: parsed.answer, hits: evidence.hits };
  if (parsed.handoff) {
    result.handoff = { ...parsed.handoff, id: saveHandoff(parsed.handoff) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Handoff store — "Work on this" hands the goal to a live Claude session

function handoffsRoot(): string {
  return join(ctxlayerHome(), 'ask', 'handoffs');
}

export function saveHandoff(handoff: AskHandoff, now: Date = new Date()): string {
  const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  mkdirSync(handoffsRoot(), { recursive: true });
  writeFileSync(join(handoffsRoot(), `${id}.json`), JSON.stringify({ ...handoff, createdAt: now.toISOString() }, null, 2) + '\n', 'utf8');
  return id;
}

export function loadHandoff(id: string): AskHandoff | undefined {
  const path = join(handoffsRoot(), `${id.replace(/[^a-z0-9-]/gi, '')}.json`);
  if (!existsSync(path)) return undefined;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as AskHandoff;
    return typeof obj.goal === 'string' ? obj : undefined;
  } catch {
    return undefined;
  }
}

/** The prompt the assist session opens with: pick up where the user left off. */
export function buildAssistPrompt(handoff: AskHandoff): string {
  return `# Help the user finish: ${handoff.goal}

The user's ambient activity observer (Context Autopilot) watched them work on this and they explicitly asked for help finishing it. Pick up where they left off — do not re-do what already worked.

## What they already tried / where it stalled
${handoff.context || '(no additional context captured)'}

Work the problem now. Ask before anything irreversible (sending messages, deleting data, purchases). When you finish, summarize what you did and what (if anything) still needs the user.`;
}
