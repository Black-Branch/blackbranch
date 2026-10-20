// Unit tests for blacklist.js — the separator-tolerant matcher and its ReDoS guard.
// Run: node --test blacklist.test.js
//
// Mirror of the same logic in web/app/lib/blacklist.ts (separate runtimes) — if
// termRegex changes here, change it there too.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { termRegex } = require('./blacklist');

test('matches a plain whole word (case-insensitive)', () => {
  const re = termRegex('slur', 'gi');
  assert.equal(re.test('you SLUR here'), true);
});

test('tolerates separator-evasion between letters', () => {
  assert.equal(termRegex('slur', 'gi').test('s.l u*r'), true);
  assert.equal(termRegex('slur', 'gi').test('s-l-u-r'), true);
});

test('does not match a substring inside a longer word (Scunthorpe guard)', () => {
  // ASCII-letter lookaround: the term must be its own word.
  assert.equal(termRegex('slur', 'gi').test('slurred'), false);
  assert.equal(termRegex('slur', 'gi').test('unslur'), false);
});

test('plural forms of a term are the same term (a plural is not a bypass)', () => {
  // "faggots man" sailed through both runtimes — the boundary lookaround read
  // the plural s as "inside a longer word". Mirrors web blocklistClassify.test.
  assert.equal(termRegex('slur', 'gi').test('slurs'), true);
  assert.equal(termRegex('slur', 'gi').test('slures'), true);
  assert.equal(termRegex('slur', 'gi').test('s l u r s'), true);
  assert.equal(termRegex('tranny', 'gi').test('trannies'), true);
  assert.equal(termRegex('tranny', 'gi').test('trannys'), true);
  // ...but a plural tail is not a license to match other suffixes.
  assert.equal(termRegex('slur', 'gi').test('slurred'), false);
  assert.equal(termRegex('slur', 'gi').test('slushy'), false);
});

test('reduces a term to letters before building the pattern', () => {
  // Punctuation in the term is stripped, not treated as a literal — so a term
  // authored with stray separators still matches the letters-only word.
  assert.equal(termRegex('s.l.u.r', 'gi').test('slur'), true);
});

test('returns null for a term with no letters', () => {
  assert.equal(termRegex('***', 'gi'), null);
  assert.equal(termRegex('---', 'gi'), null);
  assert.equal(termRegex('', 'gi'), null);
});

test('ReDoS guard: hostile punctuation run resolves fast', () => {
  // The pre-fix construction could backtrack pathologically when a term itself
  // contained separator-class chars. Letters-only terms keep the interleaved
  // separator class disjoint from every literal, so matching is linear even
  // against a long adversarial run. Bound: must finish well under a second.
  const re = termRegex('slur', 'gi');
  const hostile = '-'.repeat(5000) + 'Z';
  const start = Date.now();
  re.test(hostile);
  const ms = Date.now() - start;
  assert.ok(ms < 250, `expected <250ms, took ${ms}ms`);
});
