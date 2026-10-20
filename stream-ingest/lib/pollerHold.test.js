// A mod's "force offline" holds until every platform has confirmed offline.
//
// Without the hold, a forced end while one platform drops and the others still
// say live makes the next tick's sessionDecision 'start' — a phantom second
// session. stream-api reports the forced end on /stream/current (`forcedEndAt`);
// the poller holds while that stands and it has not yet SEEN all-offline since.
// An old press cannot hold a later stream: stream-api expires it, and the hold
// releases on the first all-offline tick.
//
// Run: node --test lib/pollerHold.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionDecision, forcedHold } from './poller.js';

test('a live platform + no session + an active forced hold → hold, not start', () => {
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: true, heldOffline: true }), 'hold');
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: true, heldOffline: false }), 'start');
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: true }), 'start', 'absent = no hold');
});

test('the hold is only about starting: a failed read still skips, offline still idles', () => {
  assert.equal(sessionDecision({ curFailed: true, curLive: false, anyPlatformLive: true, heldOffline: true }), 'skip');
  assert.equal(sessionDecision({ curFailed: false, curLive: false, anyPlatformLive: false, heldOffline: true }), 'idle');
});

test('forcedHold: held while the forced end is newer than the last all-offline observation', () => {
  assert.equal(forcedHold({ forcedEndAt: 1000, lastAllOfflineAt: null }), true);
  assert.equal(forcedHold({ forcedEndAt: 1000, lastAllOfflineAt: 900 }), true, 'an all-offline seen BEFORE the press does not release it');
  assert.equal(forcedHold({ forcedEndAt: 1000, lastAllOfflineAt: 1001 }), false, 'all-offline seen after the press releases it');
  assert.equal(forcedHold({ forcedEndAt: undefined, lastAllOfflineAt: null }), false, 'no forced end, no hold');
});
