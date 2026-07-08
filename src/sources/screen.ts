/**
 * Screen source adapter: exposes ambient activity records through the same
 * SourceAdapter interface as coding-agent transcripts. Each observed day is
 * a "session"; observations carry kind 'activity'. Workflow mining has its
 * own dedicated path (ambient/workflows) — this adapter exists so the engine
 * can enumerate and inspect ambient data uniformly.
 */

import type { Observation, ObservedProject, SourceAdapter } from '../types.js';
import { ambientRoot } from '../ambient/config.js';
import { listDays, readDay } from '../ambient/records.js';

export class ScreenAdapter implements SourceAdapter {
  name = 'screen';

  async discover(): Promise<ObservedProject[]> {
    const days = listDays();
    if (days.length === 0) return [];
    return [
      {
        id: 'ambient',
        path: ambientRoot(),
        sessionCount: days.length,
        lastActivity: `${days[0]}T23:59:59.000Z`,
      },
    ];
  }

  async observe(_project: ObservedProject): Promise<Observation[]> {
    const observations: Observation[] = [];
    for (const day of listDays()) {
      for (const record of readDay(day)) {
        const digest = record.text ? ` — ${record.text.replace(/\s+/g, ' ').slice(0, 160)}` : '';
        observations.push({
          id: record.id,
          source: this.name,
          kind: 'activity',
          timestamp: record.timestamp,
          sessionId: day,
          text: `[${record.app}] ${record.windowTitle}${digest}`,
        });
      }
    }
    observations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return observations;
  }
}
