import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserDialect,
  browserStepKey,
  hostOf,
  isBrowser,
  isObservableUrl,
  urlBlocked,
} from '../dist/ambient/browser.js';
import { DEFAULT_CONFIG, captureVerdict } from '../dist/ambient/config.js';
import { buildEpisodes, findWorkflowCandidates } from '../dist/ambient/workflows.js';
import { matchAopTrigger } from '../dist/ambient/observer.js';
import type { ActivityRecord } from '../dist/ambient/records.js';
import type { StoredAop } from '../dist/ambient/workflows.js';

test('browserDialect recognizes the browser families and rejects other apps', () => {
  assert.equal(browserDialect('Google Chrome'), 'chromium');
  assert.equal(browserDialect('Arc'), 'chromium');
  assert.equal(browserDialect('Microsoft Edge'), 'chromium');
  assert.equal(browserDialect('Safari'), 'safari');
  assert.equal(browserDialect('Slack'), undefined);
  assert.equal(isBrowser('Brave Browser'), true);
  assert.equal(isBrowser('Terminal'), false);
});

test('only real http(s) pages are observable', () => {
  assert.equal(isObservableUrl('https://mail.google.com/mail/u/0/#inbox'), true);
  assert.equal(isObservableUrl('http://localhost:3000'), true);
  assert.equal(isObservableUrl('about:blank'), false);
  assert.equal(isObservableUrl('chrome://settings'), false);
  assert.equal(isObservableUrl(''), false);
});

test('hostOf strips www and survives junk', () => {
  assert.equal(hostOf('https://www.notion.so/My-Page-abc'), 'notion.so');
  assert.equal(hostOf('https://docs.google.com/spreadsheets/d/AB12'), 'docs.google.com');
  assert.equal(hostOf('not a url'), '');
});

test('browserStepKey clusters by host + first path segment, ignoring ids and queries', () => {
  // Same spreadsheet section across days despite different doc ids / fragments.
  assert.equal(browserStepKey('https://docs.google.com/spreadsheets/d/AB12/edit#gid=0'), 'docs.google.com/spreadsheets');
  assert.equal(browserStepKey('https://docs.google.com/spreadsheets/d/ZZ99/edit'), 'docs.google.com/spreadsheets');
  // Gmail inbox regardless of message anchor.
  assert.equal(browserStepKey('https://mail.google.com/mail/u/0/#inbox'), 'mail.google.com/mail');
  assert.equal(browserStepKey('https://example.com'), 'example.com');
});

test('urlBlocked applies the title-keyword blocklist to the full URL and host', () => {
  const config = DEFAULT_CONFIG;
  assert.equal(urlBlocked(config, 'https://chase.com/banking/overview'), true, 'bank keyword in path');
  assert.equal(urlBlocked(config, 'https://accounts.google.com/login'), true, 'login keyword');
  assert.equal(urlBlocked(config, 'https://github.com/ChiragBachani/context-autopilot'), false);
});

test('captureVerdict blocks a sensitive URL even when the window title is bland', () => {
  const config = DEFAULT_CONFIG;
  const bland = 'Chase';
  // Title alone would pass (no keyword)…
  assert.deepEqual(captureVerdict(config, 'Google Chrome', bland, new Date('2026-07-08T12:00:00Z')), {
    allowed: true,
  });
  // …but the URL trips the blocklist.
  const verdict = captureVerdict(config, 'Google Chrome', bland, new Date('2026-07-08T12:00:00Z'), 'https://secure.chase.com/banking');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.reason, 'blocklisted-url');
});

function aop(trigger: StoredAop['trigger']): StoredAop {
  return {
    format: 'aop/v1',
    slug: 'weekly-report',
    title: 'Weekly report',
    rule: 'r',
    rationale: 'r',
    confidence: 'high',
    procedure: ['step'],
    trigger,
    evidence: [],
    enabled: true,
    createdAt: '2026-07-08T00:00:00.000Z',
    source: 'screen',
  };
}

test('matchAopTrigger matches on a URL pattern and requires the URL to be present', () => {
  const aops = [aop({ app: 'Chrome', urlPattern: 'mail.google.com' })];
  // Right app + right URL → match.
  assert.ok(matchAopTrigger(aops, 'Google Chrome', 'Inbox', 'https://mail.google.com/mail/u/0/#inbox'));
  // Right app but no URL known → a URL-gated trigger must NOT fire.
  assert.equal(matchAopTrigger(aops, 'Google Chrome', 'Inbox', undefined), undefined);
  // Right app, wrong URL → no match.
  assert.equal(matchAopTrigger(aops, 'Google Chrome', 'Inbox', 'https://calendar.google.com'), undefined);
});

test('a web workflow recurs across days by URL even when window titles differ', () => {
  // Two days of: Gmail inbox → open a spreadsheet → back to Gmail. The window
  // titles differ every day (message counts, subjects), but the URLs are stable,
  // so URL-keyed clustering should still recognize the repeated workflow.
  const day = (d: string, subjectSuffix: string): ActivityRecord[] => [
    rec(`${d}T09:00:00.000Z`, 'Google Chrome', `Inbox (${subjectSuffix}) - Gmail`, 'https://mail.google.com/mail/u/0/#inbox'),
    rec(`${d}T09:05:00.000Z`, 'Google Chrome', `Metrics ${subjectSuffix} - Google Sheets`, 'https://docs.google.com/spreadsheets/d/' + subjectSuffix + '/edit'),
    rec(`${d}T09:12:00.000Z`, 'Google Chrome', `Inbox (${subjectSuffix}) - Gmail`, 'https://mail.google.com/mail/u/0/#inbox'),
  ];

  const ep1 = buildEpisodes('2026-07-06', day('2026-07-06', '11'));
  const ep2 = buildEpisodes('2026-07-07', day('2026-07-07', '23'));
  const byDay = new Map([
    ['2026-07-06', ep1],
    ['2026-07-07', ep2],
  ]);
  const candidates = findWorkflowCandidates(byDay);
  assert.equal(candidates.length, 1, 'the repeated Gmail→Sheets→Gmail flow is one candidate');
  assert.deepEqual(candidates[0].days, ['2026-07-06', '2026-07-07']);
});

function rec(timestamp: string, app: string, windowTitle: string, url?: string): ActivityRecord {
  return { id: timestamp, timestamp, app, windowTitle, trigger: 'dwell', url };
}
