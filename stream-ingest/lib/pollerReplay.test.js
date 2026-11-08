// The two real nights' ends, replayed through the state model: observations → platformState →
// voteOf → aggregateLiveness, and the first tick on which every platform votes offline.
//
// Source: the prod journal (`[poller] platform states:`, `[streamplace] livestream record says
// offline (ended)`, `[kick] … StopStreamBroadcast`), read 2026-10-24. Model-level by design (plan
// P2): the readers' own end-to-end behaviour is pollerStates.test.js's job.
//
// The YouTube answers on both nights are ASSUMED answered: the journal printed the post-debounce
// state, so it cannot tell an answered not-live from a failed lookup (research §C4). Task 12 checks
// it on the next live night.
//
// Run: node --test lib/pollerReplay.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { platformState, voteOf } from './platformState.js';
import { aggregateLiveness } from './poller.js';
import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';

const at = (iso) => Date.parse(iso);
const LIVE = { raw: 'live', certain: false, key: 'k', evidence: 'helix-live' };
const off = (certain = false) => ({ raw: 'offline', certain, key: '', evidence: certain ? 'ended-stamp' : 'helix-empty' });

/** Feed ticks ({ at, obs: { platform: Observation } }); return the first all-offline tick's time. */
function firstEnd(ticks, { allUncertain = false } = {}) {
  let states = Object.fromEntries(PLATFORM_LIVENESS.PLATFORMS.map((p) => [p, null]));
  for (const t of ticks) {
    const next = {};
    for (const p of PLATFORM_LIVENESS.PLATFORMS) {
      const o = t.obs[p] ?? null;
      next[p] = platformState(states[p], o && allUncertain ? { ...o, certain: false } : o, t.at);
    }
    states = next;
    const votes = PLATFORM_LIVENESS.PLATFORMS.map((name) => ({ name, state: voteOf(states[name]) }));
    if (aggregateLiveness(votes).allConfirmedOffline) return new Date(t.at).toISOString().slice(11, 19);
  }
  return null;
}

// 10-23: OBS closed 09:58:01. stream.place stamped `ended` at 09:58:43; YouTube's watcher answered
// not-live at 09:58:42; Kick's StopStreamBroadcast arrived 09:59:51 and its API read offline.
const NIGHT_1023 = [
  { at: at('2026-10-23T09:56:53Z'), obs: { twitch: LIVE, streamplace: LIVE, youtube: LIVE, kick: LIVE } },
  { at: at('2026-10-23T09:57:53Z'), obs: { twitch: off(), streamplace: LIVE, youtube: LIVE, kick: LIVE } },
  { at: at('2026-10-23T09:58:53Z'), obs: { twitch: off(), streamplace: off(true), youtube: off(true), kick: LIVE } },
  { at: at('2026-10-23T09:59:53Z'), obs: { twitch: off(), streamplace: off(), youtube: off(), kick: off(true) } },
  { at: at('2026-10-23T10:00:54Z'), obs: { twitch: off(), streamplace: off(), youtube: off(), kick: off() } },
];

test('10-23: with the certain ends counted at once, the night ends at 09:59:53', () => {
  assert.equal(firstEnd(NIGHT_1023), '09:59:53');
});

test('10-23: with every end uncertain (two readings each), it ends at 10:00:54', () => {
  assert.equal(firstEnd(NIGHT_1023, { allUncertain: true }), '10:00:54');
});

// 10-24: OBS closed 08:35:41. stream.place stamped `ended` at 08:36:05. Kick's stop event arrived
// 08:37:50; the hint tick (Task 5) reads Kick then. A platform with no new reading on a tick ("–" in
// the plan) answers what it answered on the tick before.
const NIGHT_1024 = [
  { at: at('2026-10-24T08:35:27Z'), obs: { twitch: LIVE, streamplace: LIVE, youtube: LIVE, kick: LIVE } },
  { at: at('2026-10-24T08:36:27Z'), obs: { twitch: off(), streamplace: off(true), youtube: off(true), kick: LIVE } },
  { at: at('2026-10-24T08:37:28Z'), obs: { twitch: off(), streamplace: off(true), youtube: off(true), kick: LIVE } },
  { at: at('2026-10-24T08:37:50Z'), obs: { twitch: off(), streamplace: off(true), youtube: off(true), kick: off(true) } },
];

test('10-24: the night ends on the Kick hint tick, 08:37:50', () => {
  assert.equal(firstEnd(NIGHT_1024), '08:37:50');
});

test('10-24: without the certain ends, one tick later than the hint is still not enough', () => {
  assert.equal(firstEnd(NIGHT_1024, { allUncertain: true }), null, 'kick has only one uncertain offline by 08:37:50');
});

test('a scheduled YouTube broadcast right after the end does not hold the night open', () => {
  const up = { raw: 'upcoming', certain: false, key: 'v', evidence: 'upcoming', scheduledStart: at('2026-10-23T12:00:00Z') };
  const night = NIGHT_1023.map((t, i) => (i >= 3 ? { ...t, obs: { ...t.obs, youtube: up } } : t));
  assert.equal(firstEnd(night), '09:59:53');
});
