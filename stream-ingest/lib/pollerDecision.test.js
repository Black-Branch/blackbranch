// One tick's session decision.
//
// Collapsing "couldn't ask stream-api" into "no live session" would, with a
// platform still reporting live, mint a fresh streamId and POST /stream/start:
// a SECOND open stream.sessions row mid-stream. Web's currentStream picks the
// newest open session, so every viewer's first-message bonus would re-arm,
// watch caps reset, and viewer snapshots fragment across two rows.
//
// Only a SUCCESSFUL read may start or end a session — the same rule the
// offline path's miss threshold applies to the platform reads. "Couldn't ask"
// skips the tick; the next one re-asks.
//
// Run: node --test lib/pollerDecision.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDecision } from './poller.js';

test('a FAILED session read never starts a session — the fork bug', () => {
  assert.equal(sessionDecision({ curFailed: true, curLive: false, anyPlatformLive: true }), 'skip',
    'a platform live + unreadable session state minted a second open session mid-stream');
});

test('a FAILED session read never ends one either', () => {
  assert.equal(sessionDecision({ curFailed: true, curLive: false, anyPlatformLive: false }), 'skip');
});

test('healthy reads keep the original lifecycle', () => {
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: true }), 'start');
  assert.equal(sessionDecision({ curFailed: false, curLive: true, anyPlatformLive: true }), 'snapshot');
  assert.equal(sessionDecision({ curFailed: false, curLive: true, anyPlatformLive: false }), 'maybe-end');
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: false }), 'idle');
});

test('any single platform being live is enough to start a session, not only Twitch', () => {
  // anyPlatformLive is an OR across platforms by construction at the call site (tick()) —
  // this pins that sessionDecision itself has no Twitch-specific logic left to regress into.
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: true }), 'start');
});
