/**
 * History search: "when did I see X?" — query everything the observer has
 * ever recorded (on-device OCR text, window titles, URLs, app names) across
 * all days, newest first. This makes the observation archive useful on day
 * one, before any pattern has recurred. 100% local, plain substring scan —
 * the corpus is small enough that an index would be overengineering.
 */

import { listDays, readDay, readDaySegments } from './records.js';

export interface SearchHit {
  day: string;
  timestamp: string;
  app: string;
  windowTitle: string;
  url?: string;
  /** ±context around the OCR match; empty when the match was title/url/app. */
  snippet: string;
  /** Which field matched, for display. */
  matched: 'text' | 'title' | 'url' | 'app';
  /** Relative screenshot path, when one still exists for the moment. */
  screenshot?: string;
}

const SNIPPET_RADIUS = 80;

function snippetAround(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return '';
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(text.length, i + query.length + SNIPPET_RADIUS);
  const clipped = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${clipped}${end < text.length ? '…' : ''}`;
}

export function searchHistory(query: string, opts: { limit?: number } = {}): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const limit = opts.limit ?? 100;
  const hits: SearchHit[] = [];

  // listDays() is newest-first, and we stop as soon as the limit is reached —
  // recent history is what people search for.
  for (const day of listDays()) {
    const dayHits: SearchHit[] = [];

    for (const r of readDay(day)) {
      let matched: SearchHit['matched'] | undefined;
      let snippet = '';
      if (r.text && r.text.toLowerCase().includes(q)) {
        matched = 'text';
        snippet = snippetAround(r.text, q);
      } else if (r.windowTitle.toLowerCase().includes(q)) matched = 'title';
      else if (r.url?.toLowerCase().includes(q)) matched = 'url';
      else if (r.app.toLowerCase().includes(q)) matched = 'app';
      if (!matched) continue;
      dayHits.push({
        day,
        timestamp: r.timestamp,
        app: r.app,
        windowTitle: r.windowTitle,
        url: r.url,
        snippet,
        matched,
        screenshot: r.screenshot,
      });
    }

    // Segments carry no OCR, but their titles/urls cover stretches the
    // screenshot moments missed. Dedupe against records by app+title+minute.
    const seen = new Set(dayHits.map((h) => `${h.app}|${h.windowTitle}|${h.timestamp.slice(0, 16)}`));
    for (const s of readDaySegments(day)) {
      let matched: SearchHit['matched'] | undefined;
      if (s.windowTitle.toLowerCase().includes(q)) matched = 'title';
      else if (s.url?.toLowerCase().includes(q)) matched = 'url';
      else if (s.app.toLowerCase().includes(q)) matched = 'app';
      if (!matched) continue;
      const key = `${s.app}|${s.windowTitle}|${s.start.slice(0, 16)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dayHits.push({
        day,
        timestamp: s.start,
        app: s.app,
        windowTitle: s.windowTitle,
        url: s.url,
        snippet: '',
        matched,
      });
    }

    dayHits.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    hits.push(...dayHits);
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}
