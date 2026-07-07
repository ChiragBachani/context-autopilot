import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCorrection,
  looksLikeInjectedContent,
  normalizeForSimilarity,
  similarity,
} from '../dist/extract.js';

const afterActivity = { followsAgentActivity: true, followsInterrupt: false };
const noActivity = { followsAgentActivity: false, followsInterrupt: false };

test('correction openers are detected after agent activity', () => {
  assert.equal(classifyCorrection('No, put it back the way it was', afterActivity), true);
  assert.equal(classifyCorrection('wait — that broke the nav', afterActivity), true);
  assert.equal(classifyCorrection('Why did you delete the tests?', afterActivity), true);
});

test('correction phrases are detected mid-message', () => {
  assert.equal(classifyCorrection('Use the tokens instead of hardcoding hex', afterActivity), true);
  assert.equal(classifyCorrection('I already said we use Sunday-Saturday weeks', afterActivity), true);
  assert.equal(classifyCorrection('You ignored the popover pattern again', afterActivity), true);
  assert.equal(classifyCorrection('Use the design tokens for all colors', afterActivity), false);
});

test('nothing is a correction without prior agent activity', () => {
  assert.equal(classifyCorrection('No, put it back', noActivity), false);
});

test('ordinary follow-ups are not corrections', () => {
  assert.equal(classifyCorrection('Great. Now, let\'s talk backend.', afterActivity), false);
  assert.equal(classifyCorrection('Awesome, version c looks great. Add filters next.', afterActivity), false);
});

test('interrupt alone does not classify; phrasing still required', () => {
  const interrupted = { followsAgentActivity: false, followsInterrupt: true };
  assert.equal(classifyCorrection('Also add a settings screen', interrupted), false);
  assert.equal(classifyCorrection('stop — wrong file', interrupted), true);
});

test('harness noise is filtered', () => {
  assert.equal(looksLikeInjectedContent('<command-name>/compact</command-name>'), true);
  assert.equal(looksLikeInjectedContent('Caveat: the messages below were generated'), true);
  assert.equal(looksLikeInjectedContent('[Request interrupted by user]'), true);
  assert.equal(looksLikeInjectedContent('Add a dark mode toggle'), false);
});

test('similarity is high for rephrasings, low for unrelated text', () => {
  const a = normalizeForSimilarity('Do not add responsive CSS to the mockup files');
  const b = normalizeForSimilarity('Please do not add responsive CSS to mockup files again');
  const c = normalizeForSimilarity('Deploy the backend API to Railway with Postgres');
  assert.ok(similarity(a, b) > 0.3, `expected related > 0.3, got ${similarity(a, b)}`);
  assert.ok(similarity(a, c) < 0.2, `expected unrelated < 0.2, got ${similarity(a, c)}`);
});
