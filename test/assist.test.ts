import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';

import { corroborated, detectSituations, hasLongOperation } from '../dist/ambient/situations.js';
import { alreadyOffered, goalKeyOf, parseAssistProposal, proposeAssist, sameGoal } from '../dist/ambient/assist.js';
import { DESTRUCTIVE_DENY, buildAssistArgs } from '../dist/ambient/safety.js';
import { probeablePath } from '../dist/ambient/probes.js';
import { recentWindow } from '../dist/ambient/recent.js';
import { appendRecord, appendSegment } from '../dist/ambient/records.js';
import { DEFAULT_CONFIG } from '../dist/ambient/config.js';
import { recordAssistOffer, shouldOfferAssist, resetAssistEval } from '../dist/ambient/observer.js';
import { loadAmbientState, saveAmbientState } from '../dist/ambient/workflows.js';
import type { ActivityRecord } from '../dist/ambient/records.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-assist-'));
  resetAssistEval();
});

function rec(app: string, title: string, timestamp: string, extra: Partial<ActivityRecord> = {}): ActivityRecord {
  return { id: Math.random().toString(36).slice(2), timestamp, app, windowTitle: title, trigger: 'demo', ...extra };
}

// ---------------------------------------------------------------------------
// Detector — calibrated against the real 2026-07-26 morning

/** The shape of the real session: Storage checks + Copy ops + cross-volume search. */
function storageMorning(base: string): ActivityRecord[] {
  return [
    rec('Adobe Bridge', '', `${base}:46:00.000Z`),
    rec('System Settings', 'Storage', `${base}:48:00.000Z`),
    rec('Finder', 'Copy', `${base}:49:00.000Z`),
    rec('System Settings', 'Storage', `${base}:50:00.000Z`),
    rec('Finder', 'Copy', `${base}:50:30.000Z`),
  ];
}

test('the real storage-cleanup morning is detected as a corroborated situation', () => {
  const situations = detectSituations(storageMorning('2026-07-26T10'));
  const kinds = new Set(situations.map((s) => s.kind));
  assert.ok(kinds.has('revisit'), 'returning to Storage is a revisit signal');
  assert.ok(kinds.has('manual-repetition'), 'repeated Copy windows are manual repetition');
  assert.ok(corroborated(situations), 'two distinct kinds corroborate → worth an offer');
});

test('a single weak signal never corroborates', () => {
  const situations = detectSituations([
    rec('Mail', 'Inbox', '2026-07-26T10:00:00.000Z'),
    rec('Mail', 'Inbox', '2026-07-26T10:01:00.000Z'),
  ]);
  assert.equal(corroborated(situations), false, 'one revisit alone is not enough to interrupt');
});

test('a running long operation is recognized as a free moment to interrupt', () => {
  const situations = detectSituations([
    rec('Adobe Lightroom Classic', 'Export 429 Files', '2026-07-26T11:37:00.000Z'),
    rec('Finder', 'Searching "LaCie"', '2026-07-26T11:38:00.000Z'),
  ]);
  assert.ok(hasLongOperation(situations));
  assert.ok(corroborated(situations));
});

test('cross-volume searching is its own signal', () => {
  const situations = detectSituations([
    rec('Finder', 'Searching "LaCie"', '2026-07-26T10:53:00.000Z'),
    rec('Finder', 'Searching "This Mac"', '2026-07-26T10:54:00.000Z'),
  ]);
  const sweep = situations.find((s) => s.kind === 'search-sweep');
  assert.ok(sweep, 'searching two places is a sweep');
  assert.ok(sweep!.strength >= 0.9, 'two distinct searches is a strong signal');
});

// ---------------------------------------------------------------------------
// Recent window

test('recentWindow returns only the trailing slice', () => {
  const now = new Date('2026-07-26T12:00:00.000Z');
  appendRecord(rec('Finder', 'Old', '2026-07-26T11:00:00.000Z'));
  appendRecord(rec('Finder', 'Recent', '2026-07-26T11:58:00.000Z'));
  const win = recentWindow(5, now);
  assert.equal(win.records.length, 1);
  assert.equal(win.records[0].windowTitle, 'Recent');
});

test('recentWindow reads yesterday when the window crosses midnight', () => {
  const now = new Date('2026-07-26T00:02:00.000Z');
  appendRecord(rec('Finder', 'BeforeMidnight', '2026-07-25T23:59:00.000Z'));
  appendRecord(rec('Finder', 'AfterMidnight', '2026-07-26T00:01:00.000Z'));
  appendSegment({
    app: 'Finder', windowTitle: 'BeforeMidnight', start: '2026-07-25T23:58:00.000Z',
    end: '2026-07-25T23:59:30.000Z', seconds: 90, activeSeconds: 90, keys: 5, clicks: 1,
  });
  const win = recentWindow(5, now);
  const titles = win.records.map((r) => r.windowTitle);
  assert.ok(titles.includes('BeforeMidnight'), 'yesterday is read when the cutoff precedes midnight');
  assert.ok(titles.includes('AfterMidnight'));
  assert.equal(win.segments.length, 1, 'segments cross midnight too');
});

// ---------------------------------------------------------------------------
// Proposal parsing — null is the common, correct answer

test('a null goal means no offer', async () => {
  const proposal = await proposeAssist(
    { situations: [], records: [], segments: [], probes: [] },
    { runModel: async () => '{"goal": null}' },
  );
  assert.equal(proposal, undefined);
});

test('prose around the JSON still parses', () => {
  const parsed = parseAssistProposal(
    'Sure!\n{"goal":"Free up disk space","offer":"Want me to list duplicates?","confidence":"high",' +
      '"handoff":{"goal":"Find duplicate folders","context":"LaCie + Mac"}}\nHope that helps',
  );
  assert.equal(parsed?.goal, 'Free up disk space');
  assert.equal(parsed?.confidence, 'high');
  assert.equal(parsed?.handoff.goal, 'Find duplicate folders');
});

test('goal keys normalize so the same goal is not offered twice', () => {
  assert.equal(
    goalKeyOf('Free up space on the Mac by moving photos'),
    goalKeyOf('moving photos to free up space on my Mac!'),
  );
});

test('re-phrasings of the same goal are deduped; different goals are not', () => {
  // These are VERBATIM goals the live model produced for the same underlying
  // task minutes apart on 2026-07-26. An exact-key match treated them as two
  // goals and would have offered the same help twice.
  const a = goalKeyOf(
    'Free up space on the Mac by offloading large media (iMovie library, Lightroom catalog/photos) onto the LaCie external drive',
  );
  const b = goalKeyOf('Free up space on the Mac by moving large media folders to the LaCie external drive');
  const apartment = goalKeyOf('Compile and compare NYC apartment listings');
  assert.ok(sameGoal(a, b), 'the same goal, re-phrased, must not be offered twice');
  assert.ok(!sameGoal(a, apartment), 'genuinely different goals stay separate');
  assert.ok(alreadyOffered(b, [a]), 'alreadyOffered matches on similarity, not equality');
  assert.ok(!alreadyOffered(apartment, [a]));
});

// ---------------------------------------------------------------------------
// Safety — structural, not advisory

test('the assist launch can never use a permissive mode', () => {
  const args = buildAssistArgs('do the thing', { settingsPath: '/tmp/safe.json' });
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!args.includes('acceptEdits'), 'acceptEdits would let it edit unprompted');
  assert.ok(!args.includes('bypassPermissions'), 'bypassPermissions would disable the guarantee');
  assert.ok(args.includes('--settings'), 'deny rules must be passed');
});

test('every destructive command family is denied', () => {
  for (const cmd of ['rm', 'rmdir', 'shred', 'dd', 'mkfs', 'diskutil', 'mv', 'sudo', 'osascript']) {
    assert.ok(
      DESTRUCTIVE_DENY.some((rule) => rule.includes(`(${cmd}:`)),
      `${cmd} must be denied at the permission layer`,
    );
  }
});

test('probes refuse paths outside home and volumes', () => {
  assert.equal(probeablePath('/etc/passwd'), undefined);
  assert.equal(probeablePath('relative/path'), undefined);
  assert.ok(probeablePath('/Volumes/LaCie'));
});

// ---------------------------------------------------------------------------
// Anti-nag — the throttles are what make this liveable

const situations = () => detectSituations(storageMorning('2026-07-26T10'));

test('an offer requires a natural pause unless a long operation is running', () => {
  const now = new Date('2026-07-26T11:00:00.000Z');
  const state = loadAmbientState();
  const busy = { config: DEFAULT_CONFIG, idleSeconds: 2, situations: situations(), state, now };
  assert.equal(shouldOfferAssist(busy), false, 'mid-burst is not the moment');
  assert.equal(shouldOfferAssist({ ...busy, idleSeconds: 60 }), true);

  const waiting = detectSituations([
    ...storageMorning('2026-07-26T10'),
    rec('Adobe Lightroom Classic', 'Export 429 Files', '2026-07-26T10:51:00.000Z'),
  ]);
  assert.equal(
    shouldOfferAssist({ ...busy, situations: waiting }),
    true,
    'they are already waiting — interrupting is free',
  );
});

test('the cadence throttle and daily cap both hold', () => {
  const now = new Date('2026-07-26T11:00:00.000Z');
  const base = { config: DEFAULT_CONFIG, idleSeconds: 60, situations: situations(), now };

  recordAssistOffer('free-space', new Date('2026-07-26T10:55:00.000Z'));
  assert.equal(shouldOfferAssist({ ...base, state: loadAmbientState() }), false, '5 minutes later is too soon');

  const state = loadAmbientState();
  state.lastAssistOfferAt = '2026-07-26T08:00:00.000Z'; // long ago
  state.assistOffers = { day: '2026-07-26', count: 3 };
  saveAmbientState(state);
  assert.equal(shouldOfferAssist({ ...base, state: loadAmbientState() }), false, 'daily cap is absolute');
});

test('a dismissed situation stays dismissed for the day', () => {
  const now = new Date('2026-07-26T11:00:00.000Z');
  const sits = situations();
  const state = loadAmbientState();
  state.declinedAssistDay = '2026-07-26';
  state.declinedAssistKeys = [sits[0].key];
  saveAmbientState(state);
  assert.equal(
    shouldOfferAssist({ config: DEFAULT_CONFIG, idleSeconds: 60, situations: sits, state: loadAmbientState(), now }),
    false,
  );
});

test('offers are disabled by config', () => {
  const now = new Date('2026-07-26T11:00:00.000Z');
  assert.equal(
    shouldOfferAssist({
      config: { ...DEFAULT_CONFIG, assistOffers: false },
      idleSeconds: 600,
      situations: situations(),
      state: loadAmbientState(),
      now,
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Permission recovery — a grant that vanishes must be recoverable

test('the helper exposes a REQUEST path, not just a check', async () => {
  // Checking alone is a dead end: after `tccutil reset` (or an ad-hoc-signed
  // rebuild that invalidates the grant) preflight reports denied forever and
  // macOS never asks, so capture silently stays dead. Only a request prompts.
  const helper = await import('../dist/ambient/helper.js');
  assert.equal(typeof helper.requestScreenPermission, 'function');
  assert.equal(typeof helper.screenPermission, 'function');
  const swift = readFileSync(new URL('../src/ambient/helper.swift', import.meta.url), 'utf8');
  assert.ok(swift.includes('CGRequestScreenCaptureAccess'), 'the request API must be wired in Swift');
  assert.ok(swift.includes('screen-request'), 'the request subcommand must exist');
  const observer = readFileSync(new URL('../src/ambient/observer.ts', import.meta.url), 'utf8');
  assert.ok(
    observer.includes('requestScreenPermission()'),
    'permissionDoctor must request before giving up, or a reset grant can never be restored',
  );
});
