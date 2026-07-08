/**
 * Demo mode: replay a synthetic "day in the life" through the REAL pipeline —
 * fixture screenshots rendered natively, real on-device OCR, real workflow
 * mining, real distillation, a real macOS notification at the end. Needs no
 * permissions, and runs against an isolated data root (~/.ctxlayer/demo) so
 * actual captured data is never touched.
 *
 * The story: every Tuesday-ish morning, the user opens Gmail, downloads a
 * metrics CSV, pastes it into a Google Sheet, and emails a summary to their
 * boss. Three mornings of that + some noise = one automatable workflow.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AopEntry, Proposal } from '../types.js';
import { ambientRoot, loadConfig } from './config.js';
import { renderFixture } from './helper.js';
import { ocr } from './helper.js';
import { appendRecord, dayDir, newRecordId, readAllDays, type ActivityRecord } from './records.js';
import {
  buildEpisodes,
  distillWorkflows,
  findWorkflowCandidates,
  saveWorkflowProposals,
  type WorkflowCandidate,
} from './workflows.js';
import { notify } from './observer.js';

export function demoHome(): string {
  return join(homedir(), '.ctxlayer', 'demo');
}

/** Point every ambient module at the isolated demo root. Call first. */
export function enterDemoMode(): void {
  process.env.CTXLAYER_HOME = demoHome();
}

interface DemoStep {
  app: string;
  title: string;
  minute: number;
  screenTitle: string;
  screenLines: string[];
}

const WORKFLOW_STEPS: DemoStep[] = [
  {
    app: 'Google Chrome',
    title: 'Inbox (14) - chirag@acme.com - Gmail',
    minute: 2,
    screenTitle: 'Gmail — Inbox',
    screenLines: [
      'analytics-noreply@acme.com',
      'Your weekly metrics export is ready',
      'Attachment: weekly-metrics.csv',
      'Download attachment',
    ],
  },
  {
    app: 'Finder',
    title: 'Downloads',
    minute: 5,
    screenTitle: 'Finder — Downloads',
    screenLines: ['weekly-metrics.csv', '48 KB — CSV document', 'Today at 9:05 AM'],
  },
  {
    app: 'Google Chrome',
    title: 'Q3 Metrics Tracker - Google Sheets',
    minute: 9,
    screenTitle: 'Google Sheets — Q3 Metrics Tracker',
    screenLines: [
      'Week    Signups    Revenue    Churn',
      'Jun 23   1,204     $18,450    2.1%',
      'Jun 30   1,378     $21,020    1.9%',
      'Paste special: values only',
    ],
  },
  {
    app: 'Google Chrome',
    title: 'Compose: Weekly metrics summary - Gmail',
    minute: 16,
    screenTitle: 'Gmail — Compose',
    screenLines: [
      'To: sarah@acme.com',
      'Subject: Weekly metrics summary',
      'Signups up 14% week over week, churn down to 1.9%.',
      'Sheet is updated — full numbers attached.',
    ],
  },
];

const NOISE_STEPS: DemoStep[] = [
  {
    app: 'Slack',
    title: '#general - Acme',
    minute: 34,
    screenTitle: 'Slack — #general',
    screenLines: ['standup in 5', 'anyone seen the deploy checklist?'],
  },
  {
    app: 'Notes',
    title: 'Ideas',
    minute: 51,
    screenTitle: 'Notes — Ideas',
    screenLines: ['try the new espresso place', 'book flights for August'],
  },
];

function demoDays(count: number): string[] {
  // The most recent `count` Tuesdays, oldest first (today counts if Tuesday).
  const days: string[] = [];
  const d = new Date();
  while (days.length < count) {
    if (d.getDay() === 2) days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return days.reverse();
}

export interface DemoLog {
  (line: string): void;
}

/** Generate the fixture days: PNGs + records, OCR'd for real when possible. */
export function generateDemoData(log: DemoLog): { days: string[]; ocrWorked: boolean } {
  const days = demoDays(3);
  let ocrWorked = false;
  for (const day of days) {
    const dir = dayDir(day);
    mkdirSync(dir, { recursive: true });
    const steps = [...WORKFLOW_STEPS, ...(day === days[1] ? NOISE_STEPS : NOISE_STEPS.slice(0, 1))];
    for (const step of steps) {
      const timestamp = `${day}T09:${String(step.minute).padStart(2, '0')}:00.000Z`;
      const filename = `demo-${step.minute}.png`;
      const path = join(dir, filename);
      const rendered = renderFixture(path, step.screenTitle, step.screenLines);
      let text: string | undefined;
      if (rendered) {
        const lines = ocr(path);
        if (lines && lines.length > 0) {
          text = lines.join('\n');
          ocrWorked = true;
        }
      }
      // Fall back to the fixture's own lines if Vision is unavailable.
      text = text ?? step.screenLines.join('\n');
      const record: ActivityRecord = {
        id: newRecordId(),
        timestamp,
        app: step.app,
        windowTitle: step.title,
        trigger: 'demo',
        screenshot: rendered ? `${day}/${filename}` : undefined,
        text,
      };
      appendRecord(record);
    }
    log(`  · generated ${day} — ${steps.length} captured moments${ocrWorked ? ' (text read back with on-device OCR)' : ''}`);
  }
  return { days, ocrWorked };
}

/** A canned proposal so the demo still lands if the model call fails. */
function cannedProposal(): Proposal {
  const entry: AopEntry = {
    title: 'Weekly metrics report',
    rule: 'Every Tuesday morning, pull the weekly metrics CSV from Gmail, update the Q3 Metrics Tracker sheet, and email a summary to Sarah.',
    rationale: 'The same four-step sequence recurred on three separate mornings.',
    confidence: 'high',
    procedure: [
      'Open Gmail and find the latest "weekly metrics export" email from analytics-noreply@acme.com.',
      'Download the attached weekly-metrics.csv.',
      'Open the "Q3 Metrics Tracker" Google Sheet and paste the new week\'s values.',
      'Draft an email to sarah@acme.com summarizing signups, revenue, and churn week-over-week.',
      'Show the draft to the user before sending.',
    ],
    trigger: { app: 'Google Chrome', titlePattern: 'Gmail' },
    evidence: demoDays(3).map((day) => ({
      quote: `${day} 09:02–09:16: Gmail → Finder → Google Sheets → Gmail compose`,
      timestamp: `${day}T09:02:00.000Z`,
      sessionId: day,
    })),
  };
  return { entry, targets: [], status: 'pending' };
}

export interface DemoResult {
  days: string[];
  ocrWorked: boolean;
  candidates: WorkflowCandidate[];
  proposals: Proposal[];
  usedModel: boolean;
}

/** Run the full pipeline over the demo data. */
export async function runDemoPipeline(log: DemoLog, opts: { model?: string } = {}): Promise<DemoResult> {
  log('\n1/4  Generating three synthetic mornings (fixture screenshots + on-device OCR)…');
  const { days, ocrWorked } = generateDemoData(log);

  log('\n2/4  Mining for repeated workflows across days…');
  const episodesByDay = new Map<string, ReturnType<typeof buildEpisodes>>();
  for (const [day, records] of readAllDays()) episodesByDay.set(day, buildEpisodes(day, records));
  const candidates = findWorkflowCandidates(episodesByDay);
  log(`  · ${candidates.length} candidate workflow(s) recur across multiple days`);

  log('\n3/4  Distilling into an Agent Operating Procedure (this uses your claude CLI — ~30s)…');
  let proposals: Proposal[] = [];
  let usedModel = false;
  if (candidates.length > 0) {
    try {
      proposals = await distillWorkflows(candidates, { model: opts.model });
      usedModel = proposals.length > 0;
    } catch (err) {
      log(`  · model call failed (${err instanceof Error ? err.message : String(err)}) — using a canned proposal instead`);
    }
  }
  if (proposals.length === 0) proposals = [cannedProposal()];
  saveWorkflowProposals(proposals);
  log(`  · ${proposals.length} workflow proposal(s) ready for review`);

  log('\n4/4  Surfacing it the way the live observer would…');
  notify('Context Autopilot', `Found ${proposals.length} automatable pattern(s) in your week — open the dashboard to review.`);
  const port = loadConfig().dashboardPort;
  log(`  · notification sent — dashboard: http://localhost:${port} (Patterns tab)`);
  log(`  · demo data lives in ${ambientRoot()} and can be deleted from the Controls tab`);
  return { days, ocrWorked, candidates, proposals, usedModel };
}
