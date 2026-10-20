// Tests for the YouTube api-poller liveness watchdog.
//
// The two dead zones described in ytWatchdog.js are covered by name below. Both
// follow from gating the decision on `apiPollerFor === page`, where a catch-all
// `else` resets the stall counter — so a page with no poller at all could never
// be rebuilt. To prove these tests bite, add that gate (skip the decision when
// `pollerRegistered` is false) and the "hole (a)" / "hole (b)" cases go red.
//
// Run: node --test lib/ytWatchdog.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWatchdog, STALL_MS, STALL_TICKS } from './ytWatchdog.js';

/** Healthy steady state unless a case overrides it. */
const base = {
  readMode: 'api',
  videoId: 'dQw4w9WgXcQ',
  hasPage: true,
  pollerRegistered: true,
  msSinceHealthy: 1_000,
  stallCount: 0,
};

/** Run the decision repeatedly, threading stallCount the way tick() does. */
function runTicks(overrides, n) {
  let stallCount = overrides.stallCount ?? 0;
  const actions = [];
  for (let i = 0; i < n; i++) {
    const d = decideWatchdog({ ...base, ...overrides, stallCount });
    stallCount = d.stallCount;
    actions.push(d.action);
  }
  return actions;
}

test('a healthy poller is left alone', () => {
  const d = decideWatchdog(base);
  assert.equal(d.action, 'idle');
  assert.equal(d.stallCount, 0);
});

test('a stalled poller counts, then rebuilds on the Nth consecutive tick', () => {
  const actions = runTicks({ msSinceHealthy: STALL_MS + 1 }, STALL_TICKS + 1);
  assert.deepEqual(
    actions,
    [...Array(STALL_TICKS - 1).fill('count'), 'rebuild', 'count'],
    'should debounce for STALL_TICKS then rebuild, and start counting again after'
  );
});

test('the counter resets the moment a poll succeeds again', () => {
  // Two stalled ticks, then one healthy one, then two more stalled: must NOT
  // rebuild — the debounce is for CONSECUTIVE stalls.
  let stallCount = 0;
  const seq = [STALL_MS + 1, STALL_MS + 1, 10, STALL_MS + 1, STALL_MS + 1];
  const actions = seq.map((msSinceHealthy) => {
    const d = decideWatchdog({ ...base, msSinceHealthy, stallCount });
    stallCount = d.stallCount;
    return d.action;
  });
  assert.deepEqual(actions, ['count', 'count', 'idle', 'count', 'count']);
});

test('hole (a): a live page whose bootstrap failed — NO poller registered — still rebuilds', () => {
  // startApiPoller() returns before setting apiPollerFor when ytcfg/continuation
  // are missing. Gated on registration, this page would be invisible to the
  // watchdog forever and limp along on the ~8s passive net read.
  const actions = runTicks({ pollerRegistered: false, msSinceHealthy: STALL_MS + 1 }, STALL_TICKS);
  assert.equal(actions.at(-1), 'rebuild', 'a page with no poller at all must still be rebuilt');

  const d = decideWatchdog({
    ...base,
    pollerRegistered: false,
    msSinceHealthy: STALL_MS + 1,
    stallCount: STALL_TICKS - 1,
  });
  assert.equal(d.reason, 'no-poller', 'the journal line must distinguish this from a wedged poller');
});

test('hole (b): a poller that died while its page stayed open still rebuilds', () => {
  // The loop's `finally` nulls apiPollerFor, so a dead poller looks exactly like
  // case (a) to the tick — same fix, but worth pinning separately because the
  // cause (and the fix if someone "optimizes" the gate back) is different.
  const actions = runTicks({ pollerRegistered: false, msSinceHealthy: STALL_MS * 10 }, STALL_TICKS);
  assert.equal(actions.at(-1), 'rebuild');
});

test('a freshly-opened page is not counted as stalled', () => {
  // Guards the pageOpenedAt half of msSinceHealthy. apiPollerFor is only set
  // AFTER the bootstrap evaluate resolves, so a tick landing in that window sees
  // pollerRegistered=false on a perfectly healthy page. If the caller ever
  // computed msSinceHealthy from lastPollOkAt alone, a brand-new page would
  // inherit 0 (or a previous poller's timestamp) and trip instantly.
  const d = decideWatchdog({ ...base, pollerRegistered: false, msSinceHealthy: 500 });
  assert.equal(d.action, 'idle');
});

test('no watchdog for the passive read paths', () => {
  for (const readMode of ['net', 'dom']) {
    const d = decideWatchdog({ ...base, readMode, msSinceHealthy: STALL_MS * 100 });
    assert.equal(d.action, 'idle', `${readMode} has no liveness signal to judge`);
    assert.equal(d.stallCount, 0);
  }
});

test('no video or no page is not a stall, and clears any accumulated count', () => {
  for (const o of [{ videoId: '' }, { hasPage: false }]) {
    const d = decideWatchdog({ ...base, ...o, msSinceHealthy: STALL_MS * 10, stallCount: 2 });
    assert.equal(d.action, 'idle');
    assert.equal(d.stallCount, 0, 'a stale count must not survive into the next stream');
  }
});

test('exactly at the threshold is still healthy', () => {
  assert.equal(decideWatchdog({ ...base, msSinceHealthy: STALL_MS }).action, 'idle');
  assert.equal(decideWatchdog({ ...base, msSinceHealthy: STALL_MS + 1 }).action, 'count');
});

test('thresholds are overridable so the caller can tune without editing this module', () => {
  const d = decideWatchdog({ ...base, msSinceHealthy: 100, stallMs: 50, stallTicks: 1 });
  assert.equal(d.action, 'rebuild');
});
