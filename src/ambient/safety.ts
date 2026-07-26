/**
 * The non-destructive guarantee for Live Assist sessions.
 *
 * The requirement is "it can take actions, but it cannot in ANY scenario
 * perform destructive actions". That rules out asking the model nicely — a
 * prompt is a request, not a constraint. So the guarantee is structural, in
 * three independent layers, each sufficient on its own:
 *
 *   1. DENY RULES — a generated settings file the CLI enforces, blocking the
 *      destructive command surface outright.
 *   2. PERMISSION MODE `default` — never `acceptEdits`/`bypassPermissions`, so
 *      anything not explicitly allowed stops and asks the user. This is a
 *      DELIBERATE divergence from runAop/cmdAssist, which use acceptEdits for
 *      workflows the user has already approved. Do not "harmonize" these.
 *   3. BLAST-RADIUS CONTAINMENT — the session runs in a fresh per-offer
 *      workspace; read access elsewhere is granted explicitly and narrowly.
 *
 * The escape hatch that keeps it useful: destructive intent becomes a
 * REVIEWABLE ARTIFACT, not an action. The agent does the analysis and writes a
 * script for the user to inspect and run. It does the hard part; the
 * irreversible keystroke stays with the human.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctxlayerHome } from './config.js';

/**
 * Command prefixes a Live Assist session may never run. Deliberately broad:
 * a false "you can't do that" costs a prompt, a false "sure, deleted" costs
 * the user's data.
 */
export const DESTRUCTIVE_DENY = [
  'Bash(rm:*)',
  'Bash(rmdir:*)',
  'Bash(shred:*)',
  'Bash(dd:*)',
  'Bash(mkfs:*)',
  'Bash(diskutil:*)',
  'Bash(truncate:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(mv:*)',
  'Bash(sudo:*)',
  'Bash(killall:*)',
  'Bash(git reset:*)',
  'Bash(git clean:*)',
  'Bash(git push:*)',
  'Bash(git checkout:*)',
  // AppleScript is the back door to Finder deletion and app automation.
  'Bash(osascript:*)',
];

export function assistRoot(): string {
  return join(ctxlayerHome(), 'assist');
}

/** Per-offer workspace: the session's cwd, so stray writes land somewhere safe. */
export function assistWorkspace(offerId: string): string {
  const dir = join(assistRoot(), offerId.replace(/[^a-z0-9-]/gi, ''));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function safeSettingsPath(): string {
  return join(assistRoot(), 'safe-settings.json');
}

/** Write (or refresh) the deny-rule settings file and return its path. */
export function writeSafeSettings(): string {
  mkdirSync(assistRoot(), { recursive: true });
  const settings = {
    permissions: {
      deny: DESTRUCTIVE_DENY,
    },
  };
  const path = safeSettingsPath();
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return path;
}

/**
 * The exact argv for a Live Assist session. Kept as a pure function so a test
 * can assert the safety properties without launching anything.
 */
export function buildAssistArgs(prompt: string, opts: { web?: boolean; settingsPath: string }): string[] {
  const args: string[] = [];
  if (opts.web) args.push('--chrome');
  // NOT acceptEdits — see module docs. Anything consequential asks the user.
  args.push('--permission-mode', 'default');
  args.push('--settings', opts.settingsPath);
  args.push(prompt);
  return args;
}

/** Appended to the assist prompt so the model knows the rules and the workaround. */
export const SAFETY_BRIEF = [
  '## Ground rules (enforced, not advisory)',
  '',
  'You may investigate freely and create new files, but you CANNOT delete, move,',
  'overwrite, or otherwise destroy anything — those commands are blocked at the',
  'permission layer and will simply fail.',
  '',
  'When the task calls for destructive steps (deleting duplicates, clearing space,',
  'removing files), do NOT attempt them. Instead:',
  '  1. Do all the analysis needed to determine exactly what should be removed.',
  '  2. Write a reviewable `cleanup.sh` in your working directory with those',
  '     commands, each on its own line with a comment explaining what it frees.',
  '  3. Write `SUMMARY.md` explaining what you found, what it would reclaim, and',
  '     anything you were unsure about.',
  '  4. Tell the user to review and run it themselves.',
  '',
  'Doing the hard part is your job; the irreversible keystroke is theirs.',
].join('\n');
