// The timer heartbeat only pays for CHANGE.
//
// An unconditional heartbeat is a broadcast + a DB UPDATE every 15s, 24/7 —
// thousands a day, nearly all re-stating a paused timer nobody mutated.
//
// The contract:
//   • changed state (running clock, fresh mutation) → broadcast + persist;
//   • unchanged state → skip — EXCEPT every 4th tick still broadcasts (no
//     persist) as a resync frame, because the heartbeat's original purpose is
//     a (re)connecting overlay whose timerState aged out of the WS replay
//     buffer. Skipping forever would strand it; 60s bounds its wait.
//   • unchanged state never persists: the row already says exactly this.
//
// Run: node --test timer-heartbeat.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimer } = require('./timer');

function harness() {
  const frames = [];
  let persists = 0;
  const pool = { query: async (sql) => { if (/UPDATE stream\.timer_state/.test(String(sql))) persists++; return { rows: [] }; } };
  const timer = createTimer({ broadcast: (f) => frames.push(f), pool });
  return { frames, persists: () => persists, timer };
}

test('a paused, untouched timer skips — with a broadcast-only resync every 4th tick', () => {
  const h = harness();
  const tick = h.timer.__test.heartbeatTick;
  tick();                                   // first tick after boot: nothing cached yet → full emit
  assert.equal(h.frames.length, 1);
  assert.equal(h.persists(), 1);
  tick(); tick(); tick();                   // unchanged → three silent skips
  assert.equal(h.persists(), 1, 'an unchanged paused timer was persisted — the row already says this');
  assert.equal(h.frames.length, 1, 'a skipped tick still broadcast');
  tick();                                   // 4th consecutive skip → resync broadcast, no persist
  assert.equal(h.frames.length, 2, 'the 4th idle tick must broadcast a resync frame');
  assert.equal(h.persists(), 1, 'a resync frame must not write the DB');
  tick(); tick(); tick(); tick();           // next cycle: 3 skips + 1 resync (60s cadence)
  assert.equal(h.frames.length, 3);
  assert.equal(h.persists(), 1);
});

test('a running clock still emits and persists on every tick', () => {
  const h = harness();
  const tick = h.timer.__test.heartbeatTick;
  h.timer.control('play');
  const after = { frames: h.frames.length, persists: h.persists() };
  h.timer.__test.st.updatedAt -= 16_000;    // 16s pass on the wall clock
  tick();
  assert.equal(h.frames.length, after.frames + 1, 'a running clock must heartbeat — remaining changed');
  assert.equal(h.persists(), after.persists + 1, 'a running clock must stay fresh in the DB against a crash');
});

test('a mutation resets the cadence — the next tick does not re-persist the same state', () => {
  const h = harness();
  const tick = h.timer.__test.heartbeatTick;
  h.timer.adjust('10m');                    // emit() with a delta popup
  const persistsAfterAdjust = h.persists();
  tick();                                   // nothing changed since the mutation's own emit
  assert.equal(h.persists(), persistsAfterAdjust,
    'the tick after a mutation re-persisted unchanged state — emit() did not sync the heartbeat cache');
});

test('the delta popup does not poison the cache — a heartbeat never replays it', () => {
  // emit(applied) broadcasts deltaSec>0 once (the overlay's "+10:00" popup).
  // If the heartbeat cache keyed on THAT frame verbatim, the next tick would
  // see "changed" (deltaSec 0 vs 600) and re-emit; worse, caching the popup
  // frame and replaying it would flash "+10:00" at every resync.
  const h = harness();
  const tick = h.timer.__test.heartbeatTick;
  h.timer.adjust('10m');
  tick(); tick(); tick(); tick();           // one of these is the resync broadcast
  const resync = h.frames[h.frames.length - 1];
  assert.equal(resync.deltaSec, 0, 'a heartbeat frame replayed a mutation popup');
});
