// Tests for echo suppression — the "send to all" copy coming back from a
// platform and rendering as a second, genuine-looking chat line.
//
// ── Read before changing any constant ────────────────────────────────────────
//
// Echoes can arrive well past the 20s text window. Widening the window is the
// wrong fix and is asserted against below: the window is keyed on message TEXT,
// so every extra second is another second in which a viewer typing "lol" is
// deleted outright, with no chat_log row and no trace. A visible duplicate is
// recoverable; a swallowed viewer message is not.
//
// So the two longer-lived paths both carry PROOF rather than a text guess:
//
//   1. Exact platform message id — the id handed back when we posted
//      (site.chat_message_platform_copies) coming back. Twitch and Kick match
//      exactly. YouTube does NOT and cannot: we SEND via the Data API (ids
//      prefixed "LCC.") and READ via innertube get_live_chat (renderer ids), so
//      the two never match. YouTube is covered by path 2.
//
//   2. Sender identity — the echo carries the sending user's own platform
//      account id, or resolves to their canonical user. A viewer's message can
//      never satisfy this, which is what makes a 120s window safe here when 20s
//      is not safe for text.
//
// This file tests the DECISION. The WIRING — that /chat/echo-copies really
// populates the map /chat really reads — is covered by echo-wiring.test.js.
//
// Run: node --test echo-dedup.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  decideEchoSuppression, echoIdKey, normText, normTextWithPath,
  ALL_SUPPRESS_TTL, ALL_ECHO_GRACE, ECHO_CONFIRMED_TTL,
} = require('./chat-dedup');

/** An armed send-to-all entry, as /chat/native builds it. */
function armed(text, platforms = ['twitch', 'youtube'], budget = 1) {
  return {
    platforms: new Map(platforms.map((p) => [p, budget])),
    remaining: platforms.length,
    raws: new Set([normTextWithPath(text)]),
  };
}

/** Run the real decision for an incoming message. */
function decide(entry, incoming, { platform = 'twitch', elapsed = 0, identityConfirmed = false } = {}) {
  return decideEchoSuppression({
    entry, platform, elapsed,
    key: normText(incoming),
    incomingRaw: normTextWithPath(incoming),
    identityConfirmed,
  });
}

// ── The bug this change exists to fix ───────────────────────────────────────

test('the median leaked echo (36.7s) is suppressed — because the sender is known', () => {
  const entry = armed('the fed just cut rates');
  const late = 36_700;
  assert.ok(late > ALL_SUPPRESS_TTL, 'precondition: this is past the text window');

  assert.equal(decide(entry, 'the fed just cut rates', { elapsed: late }).suppress, false,
    'text alone must NOT stretch this far — that is the change we are refusing to make');
  assert.equal(decide(entry, 'the fed just cut rates', { elapsed: late, identityConfirmed: true }).suppress, true,
    'the sender\'s own account coming back IS the echo');
});

test("THE OTHER BUG this must not cause: a viewer's message is never swallowed by the long window", () => {
  // Same text, same moment, same platform — the ONLY difference is that this
  // message did not come from the sender's account. identityConfirmed is false
  // precisely because /chat could not match the account id or the canonical id.
  const entry = armed('lol');
  for (const elapsed of [21_000, 36_700, 80_800, ECHO_CONFIRMED_TTL - 1]) {
    assert.equal(decide(entry, 'lol', { elapsed }).suppress, false,
      `a viewer typing "lol" at ${elapsed}ms must survive`);
  }
});

// ── Identity waives the budget, and nothing else ────────────────────────────

test('identity waives the per-platform budget (the second echo of one message)', () => {
  const spent = armed('om', ['twitch'], 0);   // budget already consumed
  const late = ALL_ECHO_GRACE + 1_000;        // and past the grace window
  assert.equal(decide(spent, 'om', { elapsed: late }).suppress, false, 'precondition: budget-spent leaks today');
  assert.equal(decide(spent, 'om', { elapsed: late, identityConfirmed: true }).suppress, true);
});

test('identity does NOT waive the expected-platform scope', () => {
  // We never fanned out to kick, so a message there is the streamer TYPING on
  // kick, not an echo. Suppressing it would delete a message nobody sent twice.
  const entry = armed('good evening', ['twitch', 'youtube']);
  const v = decide(entry, 'good evening', { platform: 'kick', elapsed: 5_000, identityConfirmed: true });
  assert.equal(v.suppress, false);
  assert.equal(v.reason, 'unexpected-platform');
});

test('identity does NOT waive the bare-link check', () => {
  // The streamer send-to-alls one video, then posts a DIFFERENT one himself.
  // Both normalize to the same bare-host key; only the path separates them.
  const entry = armed('youtube.com/watch?v=AAA');
  const v = decide(entry, 'youtube.com/watch?v=ZZZ', { elapsed: 5_000, identityConfirmed: true });
  assert.equal(v.suppress, false, 'his own second link must not vanish');
  assert.equal(v.reason, 'different-link');
  // ...while the real echo of the same link still goes.
  assert.equal(decide(entry, 'youtube.com/watch?v=AAA', { elapsed: 5_000, identityConfirmed: true }).suppress, true);
});

test('the identity window is bounded too — it is longer, not infinite', () => {
  const entry = armed('hello');
  assert.equal(decide(entry, 'hello', { elapsed: ECHO_CONFIRMED_TTL - 1, identityConfirmed: true }).suppress, true);
  const over = decide(entry, 'hello', { elapsed: ECHO_CONFIRMED_TTL, identityConfirmed: true });
  assert.equal(over.suppress, false);
  assert.equal(over.reason, 'expired');
});

// ── Behaviour that must NOT have changed ────────────────────────────────────

test('the pre-existing text path is byte-for-byte the same policy', () => {
  const entry = armed('hi chat');
  assert.equal(decide(entry, 'hi chat', { elapsed: 1_000 }).suppress, true, 'in budget, in window');
  assert.equal(decide(entry, 'hi chat', { elapsed: ALL_SUPPRESS_TTL - 1 }).suppress, true, 'edge of the window');
  assert.equal(decide(entry, 'hi chat', { elapsed: ALL_SUPPRESS_TTL }).suppress, false, 'one ms past it');

  const spent = armed('hi chat', ['twitch'], 0);
  assert.equal(decide(spent, 'hi chat', { elapsed: ALL_ECHO_GRACE - 1 }).suppress, true, 'grace covers a double echo');
  assert.equal(decide(spent, 'hi chat', { elapsed: ALL_ECHO_GRACE }).suppress, false, 'and stops when it should');
});

test('a legacy caller sending only a count still dedups (platforms: null)', () => {
  // Unreachable today by an early return in the web route — kept deliberately,
  // see the note in chat.js. If it ever becomes reachable it must still work.
  const legacy = { platforms: null, remaining: 2, raws: new Set(['whatever']) };
  const v = decide(legacy, 'whatever', { platform: 'anything', elapsed: 1_000 });
  assert.equal(v.suppress, true);
  assert.equal(v.budget, 2, 'budget reads through to `remaining` for legacy entries');
});

// ── The exact-id key ────────────────────────────────────────────────────────

test('echoIdKey is platform-scoped and case-insensitive', () => {
  assert.equal(echoIdKey('Twitch', 'abc'), echoIdKey('twitch', 'abc'));
  assert.notEqual(echoIdKey('twitch', 'abc'), echoIdKey('kick', 'abc'),
    'the same id string on two platforms must not collide');
});

// ── Source scan: the id path must run BEFORE the text path ──────────────────
// Not a style point. The id path is exact and the text path can consume budget
// and learn aliases; running the guess first would let it answer for a message
// we can prove the answer to.

const chatSrc = readFileSync(join(__dirname, 'chat.js'), 'utf8');

test('chat.js checks the exact id before it consults the text window', () => {
  const idAt = chatSrc.indexOf('suppressed echo BY ID');
  const textAt = chatSrc.indexOf('decideEchoSuppression({');
  assert.ok(idAt > 0, 'the exact-id path is present');
  assert.ok(textAt > 0, 'the text path is present');
  assert.ok(idAt < textAt, 'the exact path must be consulted first');
});

test('identity-confirmed suppression does not spend the text budget', () => {
  // Budget bounds how much a GUESS may swallow. There is no guess when identity
  // is confirmed, and spending it there would make a later genuine echo of a
  // different message leak.
  assert.match(chatSrc, /if \(!identityConfirmed\) \{[\s\S]{0,400}?_dedup\.platforms\.set/,
    'the budget decrement is gated on the un-confirmed case');
});

// ── Vacuity anchor (END of file) ────────────────────────────────────────────
// Every scan above reads chat.js. A truncated read makes `indexOf` return -1 and
// `assert.match` throw, so those fail loudly — but only because they are POSITIVE
// assertions. This anchor is what keeps that true if a negative one is ever added
// above it: it proves the read reached the end of the real file.
test('VACUITY ANCHOR: chat.js was read whole', () => {
  assert.ok(chatSrc.length > 20_000, `chat.js read back as ${chatSrc.length} bytes — truncated`);
  assert.match(chatSrc.trimEnd(), /module\.exports = \{ createChat \};$/,
    'the read did not reach the end of chat.js');
});
