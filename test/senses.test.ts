import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIgnoredPath, FileWatcher } from '../dist/ambient/files.js';
import { captureVerdict, DEFAULT_CONFIG } from '../dist/ambient/config.js';

beforeEach(() => {
  process.env.CTXLAYER_HOME = mkdtempSync(join(tmpdir(), 'ctxlayer-senses-'));
});

test('isIgnoredPath filters dotfiles, caches, temp/lock files — keeps real docs', () => {
  assert.equal(isIgnoredPath('/Users/me/Desktop/invoice.pdf'), false);
  assert.equal(isIgnoredPath('/Users/me/Documents/report.docx'), false);
  assert.equal(isIgnoredPath('/Users/me/Desktop/.DS_Store'), true);
  assert.equal(isIgnoredPath('/Users/me/.config/thing'), true);
  assert.equal(isIgnoredPath('/Users/me/project/node_modules/x/index.js'), true);
  assert.equal(isIgnoredPath('/Users/me/Library/Caches/x'), true);
  assert.equal(isIgnoredPath('/Users/me/Downloads/movie.mp4.crdownload'), true);
  assert.equal(isIgnoredPath('/Users/me/Desktop/~$report.docx'), true);
});

test('FileWatcher debounces per path and rate-limits', () => {
  const w = new FileWatcher();
  const p = '/Users/me/Desktop/a.pdf';
  assert.equal(w.test_consider(p, 1000), true, 'first save emits');
  assert.equal(w.test_consider(p, 3000), false, 'same path within 5s debounced');
  assert.equal(w.test_consider(p, 7000), true, 'after debounce, emits again');
  // Different path is independent.
  assert.equal(w.test_consider('/Users/me/Desktop/b.pdf', 7000), true);
  // Ignored path never emits.
  assert.equal(w.test_consider('/Users/me/Desktop/.DS_Store', 20000), false);
});

test('clipboard gating reuses captureVerdict: blocked inside password managers/banking', () => {
  const c = { ...DEFAULT_CONFIG };
  // Copy made while 1Password is frontmost → blocked.
  assert.equal(captureVerdict(c, '1Password', 'Vault', new Date(), 'secret token').allowed, false);
  // Copy on a banking page → blocked by title/url keyword.
  assert.equal(captureVerdict(c, 'Google Chrome', 'Chase Bank', new Date(), 'account 1234').allowed, false);
  // Ordinary copy → allowed.
  assert.equal(captureVerdict(c, 'Notes', 'Ideas', new Date(), 'buy milk').allowed, true);
});

test('clipboard capture defaults ON', () => {
  assert.equal(DEFAULT_CONFIG.clipboard, true);
  assert.deepEqual(DEFAULT_CONFIG.watchDirs, ['Desktop', 'Documents', 'Downloads']);
});
