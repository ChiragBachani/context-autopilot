/**
 * The trailing window of activity — "what is the user doing right now".
 *
 * Everything else in the codebase reads a whole day; Live Assist needs the last
 * few minutes so it can notice an in-flight goal early (verified against real
 * data: a 5-minute window surfaces the intent ~7 minutes into a session, an
 * hour before the user would otherwise finish by hand). Crossing local midnight
 * means reading yesterday's directory too — segments and records bucket by
 * LOCAL day (see appendSegment/appendRecord).
 */

import { dayKey, readDay, readDaySegments, type ActivityRecord, type ActivitySegment } from './records.js';

/** Default trailing window. Short on purpose — see module docs. */
export const RECENT_WINDOW_MINUTES = 5;

export interface RecentWindow {
  /** Inclusive lower bound (ISO). */
  since: string;
  segments: ActivitySegment[];
  records: ActivityRecord[];
}

/**
 * Activity from the last `minutes`. Reads today and, when the cutoff falls
 * before local midnight, yesterday as well.
 */
export function recentWindow(minutes: number = RECENT_WINDOW_MINUTES, now: Date = new Date()): RecentWindow {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const days = [dayKey(now)];
  const cutoffDay = dayKey(cutoff);
  if (cutoffDay !== days[0]) days.unshift(cutoffDay);

  const cutoffMs = cutoff.getTime();
  const nowMs = now.getTime();
  const segments: ActivitySegment[] = [];
  const records: ActivityRecord[] = [];
  for (const day of days) {
    for (const seg of readDaySegments(day)) {
      // A segment counts when any part of it overlaps the window.
      const end = Date.parse(seg.end);
      if (Number.isFinite(end) && end >= cutoffMs && Date.parse(seg.start) <= nowMs) segments.push(seg);
    }
    for (const rec of readDay(day)) {
      const at = Date.parse(rec.timestamp);
      if (Number.isFinite(at) && at >= cutoffMs && at <= nowMs) records.push(rec);
    }
  }
  segments.sort((a, b) => a.start.localeCompare(b.start));
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { since: cutoff.toISOString(), segments, records };
}
