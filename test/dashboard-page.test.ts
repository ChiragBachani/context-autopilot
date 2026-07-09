import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE } from '../dist/ambient/dashboard.js';

// The dashboard is one big template literal with one <script>. A single
// syntax error silently kills EVERY handler ("the app isn't clickable"),
// which tsc cannot catch — so parse the shipped script on every test run.
test('the dashboard page script parses (a syntax error = dead UI)', () => {
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, 'page has an inline script');
  for (const src of scripts) {
    assert.doesNotThrow(() => new Function(src), 'inline <script> must be valid JavaScript');
  }
});
