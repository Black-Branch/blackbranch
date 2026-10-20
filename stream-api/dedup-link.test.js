// Tests for send-to-all dedup on bare-link messages.
//
// normText deliberately discards URL PATHS, because platforms (YouTube notably)
// truncate link text in their echo, so paths can't be compared directly. That is
// fine when the message has other words to key on, and dangerous when it does
// not: a send-to-all of a BARE link normalizes to nothing but `https://host`.
//
// Without a guard, any viewer posting a DIFFERENT link to the same host inside
// the window matches that key and their message is dropped outright — no
// chat_log INSERT, no scoring, no broadcast, logged only as `[dedup] suppressed
// echo`. Platform scoping does not save it: Casey fans out to exactly the
// platforms his viewers chat on.
//
// The asymmetry that drives the design: failing to dedup shows Casey his own link
// twice (visible, harmless). Over-deduping deletes a viewer's message with no
// trace (silent, unrecoverable). Prefer the former every time.
//
// Run: node --test dedup-link.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// The REAL shipped helpers (chat-dedup.js).
const { normText, isWeakDedupKey, normTextWithPath, sameLinkText } = require('./chat-dedup');

/** Would `incoming` be suppressed as an echo of `armed`? (expected platform, in window) */
function suppressed(armed, incoming) {
  const key = normText(armed);
  const raws = new Set([normTextWithPath(armed)]);
  if (normText(incoming) !== key) return false;          // different dedup key entirely
  return !isWeakDedupKey(key) ||
    [...raws].some((r) => sameLinkText(r, normTextWithPath(incoming)));
}

test('THE BUG: a different link to the same host is NOT swallowed', () => {
  // Casey send-to-alls youtube.com/watch?v=AAA; a Twitch viewer posts ...v=ZZZ.
  const armed = 'youtube.com/watch?v=AAA';
  const viewer = 'youtube.com/watch?v=ZZZ';
  assert.equal(normText(armed), normText(viewer), 'precondition: the keys really do collide');
  assert.equal(isWeakDedupKey(normText(armed)), true, 'precondition: the key is bare-host-only');
  assert.equal(suppressed(armed, viewer), false, "the viewer's message must survive");
});

test('the REAL echo of the same bare link is still suppressed', () => {
  assert.equal(suppressed('youtube.com/watch?v=AAA', 'youtube.com/watch?v=AAA'), true);
});

test('a TRUNCATED echo still dedups — the reason paths were dropped originally', () => {
  // Platforms shorten link display text; the echo is a prefix of the original.
  assert.equal(suppressed('youtube.com/watch?v=AAABBBCCC', 'youtube.com/watch?v=AAABB…'), true);
  assert.equal(suppressed('youtube.com/watch?v=AAABBBCCC', 'youtube.com/watch?v=AAABB...'), true);
});

test('truncation does NOT let a different path through', () => {
  // Diverges before the truncation point, so it is not a prefix.
  assert.equal(suppressed('youtube.com/watch?v=AAABBBCCC', 'youtube.com/watch?v=ZZZBB…'), false);
});

test('www./scheme differences do not defeat the match', () => {
  assert.equal(suppressed('https://www.youtube.com/watch?v=AAA', 'youtube.com/watch?v=AAA'), true);
});

test('messages WITH other words are unaffected — the key is not weak', () => {
  // These never had the problem; the extra check must not start rejecting them.
  assert.equal(isWeakDedupKey(normText('check this out youtube.com/watch?v=AAA')), false);
  assert.equal(suppressed('check this out youtube.com/watch?v=AAA',
                          'check this out youtube.com/watch?v=ZZZ'), true,
    'unchanged prior behaviour: with surrounding text the key still collapses paths');
});

test('a bare HOST with no path still dedups against itself', () => {
  assert.equal(suppressed('youtube.com', 'youtube.com'), true);
});

test('two different bare hosts never collide anyway', () => {
  assert.equal(suppressed('youtube.com', 'twitch.tv'), false);
});

test('short paths fall back to exact comparison, not prefix', () => {
  // Below the 8-char floor, prefix matching would be too loose: "ab.co/1" must
  // not swallow "ab.co/12".
  assert.equal(sameLinkText('ab.co/1', 'ab.co/12'), false);
  assert.equal(sameLinkText('ab.co/1', 'ab.co/1'), true);
});

// ── the shipped code must carry this ─────────────────────────────────────────
// LINE comments first, then blocks. Stripping blocks first fails SILENTLY:
// a `//` comment containing `/*` reads as an OPENER to the block regex, and
// everything down to the next `*/` disappears. chat.js:245 holds a literal `*/`
// inside a regex — `message.replace(/^Cheer\s*\d+\s*/i, '')` — so ONE route-list
// comment added above it would delete lines 1-245 from this scan and every
// assertion below would pass over the hole. (The line filter only drops lines
// that START with `//`, so it can never damage that regex itself.)
// Cost of getting this wrong, measured: 2,591 bytes of index.js, `b2af0f2`.
const src = readFileSync(join(__dirname, 'chat.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// Vacuity guard, anchored on the END of chat.js. Truncation always eats the
// tail, so an anchor near the top stays green while the region under test is
// gone.
test('the chat.js scan sees the whole file, tail included', () => {
  assert.ok(src.length > 5000, 'chat.js source scan came back too small to be the real file');
  assert.match(src, /module\.exports = \{ createChat \}/,
    'the scan lost the END of chat.js — a stray `/*` in a line comment truncated it, and the ' +
    'assertions below are now checking a file that stops early');
});

// The suppression DECISION lives in chat-dedup.js and is tested directly (see
// echo-dedup.test.js). What chat.js owns, and what is checked here, is the
// ARMING: without `raws` the weak-key guard has
// nothing to compare against and can never pass.
const policySrc = readFileSync(join(__dirname, 'chat-dedup.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the chat-dedup.js scan sees the whole file, tail included', () => {
  assert.ok(policySrc.length > 2000, 'chat-dedup.js source scan came back too small to be the real file');
  assert.match(policySrc, /decideEchoSuppression, echoIdKey,/,
    'the scan lost the END of chat-dedup.js and the assertion below is checking a file that stops early');
});

test('the suppression decision gates on the link check for weak keys', () => {
  assert.match(policySrc, /const linkOk = !isWeakDedupKey\(key\)/,
    'the weak-key guard is gone — a bare-link send-to-all would swallow viewers again');
  assert.match(policySrc, /const suppress = expected && linkOk &&/,
    'linkOk is no longer part of the suppression decision');
  assert.match(src, /raws: new Set\(\[normTextWithPath\(/,
    'the path-preserving forms are no longer armed, so linkOk can never pass');
});
