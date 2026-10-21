// Unit tests for night-liveness.js — the outage watchdog that retroactively
// pauses a night's timer on a SUSTAINED liveness drop, and resumes it only if
// it was the one that paused it.
//
// Run: node --test night-liveness.test.js
//
// ── Why real timer.js instances, not a mock ─────────────────────────────────
// timer.pauseRetroactive() does real accumulator math against real
// Date.now(). A mock that just records "was I called" would prove this module
// dials the right method, but not that the right NUMBER reaches it — so the
// "exact numbers" test below drives a real createTimer() the same way
// timer.test.js's own `nightTimer()` helper does, and rewinds its anchor by
// hand instead of sleeping.
//
// night-liveness's OWN debounce pacing is a separate clock (`nowFn`, injected)
// from the timer's real Date.now() — advancing the fake clock paces the
// debounce window without waiting in real time, while the timer's own
// accumulator math still reads the real wall clock (as it does in
// production). Keeping the two independent is what lets the "exact numbers"
// test assert whole-second results without a real 2-minute sleep.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimer } = require('./timer');
const { createNightLiveness } = require('./night-liveness');

/** A timer mid-night, matching timer.test.js's own nightTimer() helper. */
function nightTimer({ gapSec = 600, elapsedSec = 3600, durationSec = 25200,
                      seedSec = 0, running = true } = {}) {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  Object.assign(t.__test.st, { running, remainingSec: gapSec, updatedAt: Date.now() });
  // A night that began an hour ago: the arming rule (night-liveness.js) needs
  // a start instant, and a null one must read as DISARMED — so every fixture
  // carries a real one, and the tests below exercise the rule, not a hole.
  Object.assign(t.__test.st.night, { active: true, durationSec, elapsedSec, seedSec,
    startedAt: new Date(Date.now() - 3600_000) });
  return t;
}

/** A controllable clock for night-liveness's own debounce pacing. */
function fakeClock(start = Date.now()) {
  let now = start;
  const fn = () => now;
  fn.advance = (ms) => { now += ms; };
  return fn;
}

/** Counts calls to a timer method without a mocking library. */
function spyOn(obj, method) {
  const calls = [];
  const orig = obj[method].bind(obj);
  obj[method] = (...args) => { calls.push(args); return orig(...args); };
  return calls;
}

/** Silences console.log/warn around an async block — the state-change logs are signal, not noise to leave printing during a test run. */
async function quietAsync(fn) {
  const orig = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try { await fn(); } finally { Object.assign(console, orig); }
}

test('a flap shorter than the debounce never touches the timer', async () => {
  const t = nightTimer();
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const controlCalls = spyOn(t, 'control');
  const nowFn = fakeClock();
  let live = false;
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: Date.now() - 10 }),
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();       // not-live: debounce starts
  nowFn.advance(60_000);        // 60s — under the 120s debounce
  live = true;
  await nl.__test.tick();       // live again: the flap resolved before the debounce fired

  assert.equal(pauseCalls.length, 0, 'a flap must never trigger a retroactive pause');
  assert.equal(controlCalls.filter((a) => a[0] === 'play').length, 0,
    'nothing paused it, so nothing should have resumed it either');
  assert.equal(t.snapshot().running, true, 'the timer must never have stopped running');
});

test('a sustained outage pauses retroactively — gap and elapsed restored to the lastLive moment, exact numbers', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const realNow = Date.now();
  t.__test.st.updatedAt = realNow - 400_000; // 400 real seconds since the timer's own last anchor
  const lastLiveMs = realNow - 300_000;      // the stream was last provably live 300s ago

  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs }),
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();          // not-live: debounce starts (fake clock)
  nowFn.advance(120_000);          // the debounce's OWN pacing — independent of the timer's real clock
  await nl.__test.tick();          // still not-live, and the debounce has now elapsed → pause fires

  const s = t.snapshot();
  assert.equal(s.running, false);
  // timer.js banks the real 400s first (gap 5000→4600, elapsed 3600→4000), THEN
  // refunds just the 300s outage (gap +300, elapsed −300) — see timer.test.js's
  // own pauseRetroactive tests for the same arithmetic pinned in isolation.
  assert.equal(Math.round(s.remainingSec), 4900);
  assert.equal(Math.round(s.night.elapsedSec), 3700);
});

test('resume plays ONLY when liveness paused it', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const controlCalls = spyOn(t, 'control');
  let live = false;
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: Date.now() - 1000 }),
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();          // debounce starts
  nowFn.advance(120_000);
  await nl.__test.tick();          // sustained → paused retroactively
  assert.equal(t.snapshot().running, false, 'must be paused before resume can be tested');

  live = true;
  await nl.__test.tick();          // liveness restored

  assert.equal(t.snapshot().running, true, 'liveness paused it, so liveness must resume it');
  assert.equal(controlCalls.filter((a) => a[0] === 'play').length, 1,
    'control(\'play\') must fire exactly once on resume');
});

test('scene-paused timer is untouched by liveness in both directions', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200, running: true });
  t.control('pause'); // simulates the OBS pre-show scene pause — NOT liveness
  const pausedGap = t.snapshot().remainingSec;
  const pausedElapsed = t.snapshot().night.elapsedSec;

  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const controlCalls = spyOn(t, 'control');
  let getLiveCalls = 0;
  let live = false;
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => { getLiveCalls++; return live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: Date.now() - 10 }; },
    debounceMs: 120_000,
    nowFn,
  });

  // Not-live, well past what would be a sustained-outage window if this timer
  // were running — must do nothing, because a manually paused timer is not
  // liveness's to touch.
  await nl.__test.tick();
  nowFn.advance(500_000);
  await nl.__test.tick();
  assert.equal(pauseCalls.length, 0, 'a scene-paused timer must never be pauseRetroactive-d');

  // And live again — must not resume it either; liveness never paused it.
  live = true;
  await nl.__test.tick();
  assert.equal(controlCalls.filter((a) => a[0] === 'play').length, 0,
    'liveness did not pause it, so liveness must not resume it');

  assert.equal(t.snapshot().running, false, 'the scene pause must still hold');
  assert.equal(t.snapshot().remainingSec, pausedGap, 'liveness must not have moved the gap');
  assert.equal(t.snapshot().night.elapsedSec, pausedElapsed, 'liveness must not have moved the ember');
  assert.equal(getLiveCalls, 0, 'a scene-paused, never-liveness-paused timer needs no liveness read at all');
});

test('getLive() throwing is UNKNOWN: no action, and the pending debounce is cleared', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  let fail = false;
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => {
      if (fail) throw new Error('db unreachable');
      return { live: false, lastLiveMs: Date.now() - 10 };
    },
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();           // not-live: debounce starts (t=0)
  nowFn.advance(90_000);            // 90s in — under the 120s debounce, not yet due

  fail = true;
  await quietAsync(() => nl.__test.tick()); // getLive() throws → UNKNOWN, debounce cleared

  fail = false;
  nowFn.advance(90_000);            // 180s since the ORIGINAL debounce start — would have fired if not cleared
  await nl.__test.tick();           // known again, still not-live: if the debounce had survived, this fires now
  assert.equal(pauseCalls.length, 0,
    'the old debounce must have been thrown away — 90s (this tick) since restart is under 120s');

  nowFn.advance(120_000);           // a full fresh debounce window from the RESTART point
  await nl.__test.tick();
  assert.equal(pauseCalls.length, 1, 'a fresh debounce, timed from the restart, must still be able to fire');
});

test('getLive() throwing logs once per state change, not once per tick', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => { throw new Error('db unreachable'); },
    debounceMs: 120_000,
    nowFn,
  });

  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await nl.__test.tick();
    await nl.__test.tick();
    await nl.__test.tick();
  } finally {
    console.warn = orig;
  }
  const unknownLines = lines.filter((l) => l.includes('night-liveness') && l.includes('getLive'));
  assert.equal(unknownLines.length, 1, 'three consecutive failures must log once, not three times');
});

test('a night ending clears the liveness-paused flag — it does not resume the NEXT night', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const controlCalls = spyOn(t, 'control');
  let live = false;
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: Date.now() - 10 }),
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();
  nowFn.advance(120_000);
  await nl.__test.tick();
  assert.equal(t.snapshot().running, false, 'paused by liveness');

  // The night ends (a mod's call, not liveness's business) while still paused.
  t.__test.st.night.active = false;

  await nl.__test.tick(); // no night → liveness must stand down, including forgetting the flag
  live = true;
  await nl.__test.tick(); // live again, but there is still no night active — nothing to resume for
  assert.equal(controlCalls.filter((a) => a[0] === 'play').length, 0,
    'a stale liveness-pause flag must not resume a timer once its night has ended');
});

// ── the check-then-act race ─────────────────────────────────────────────────
//
// `tick()` reads `timer.snapshot()`, then `await`s `getLive()` — a real DB
// round trip in production. Anything can happen to the timer during that
// suspension: in particular, OBS can switch to the pre-show scene and scene-pause
// it. A tick that decided "still running, sustained outage, fire the pause"
// using a snapshot taken BEFORE the await would fire on a timer that is no
// longer running by the time it actually acts — wrongly claiming liveness
// ownership over what is really a scene pause (and later resuming OVER
// the pre-show scene), and asking timer.js to refund wall-clock time against an
// `elapsedSec` that has sat frozen since the scene pause landed.

test('a scene-pause landing DURING an in-flight getLive() must not fire a retroactive pause, claim ownership, or later resume over the scene', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const controlCalls = spyOn(t, 'control');
  const nowFn = fakeClock();
  let raceOnNextCall = false;
  let live = false;
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => {
      if (raceOnNextCall) {
        // The race: by the time this promise resolves, the REAL timer has
        // already been paused by something else (the scene handler) — a
        // `timer.snapshot()` taken before this call started is now stale.
        raceOnNextCall = false; // one-shot: only this tick's poll races
        t.control('pause');
      }
      return live
        ? { live: true, lastLiveMs: null }
        : { live: false, lastLiveMs: Date.now() - 10 };
    },
    debounceMs: 120_000,
    nowFn,
  });

  await nl.__test.tick();     // debounce starts; the timer is genuinely still running here
  nowFn.advance(120_000);     // the debounce window has elapsed on the fake clock

  const gapBefore = t.snapshot().remainingSec;
  const elapsedBefore = t.snapshot().night.elapsedSec;

  raceOnNextCall = true;
  await nl.__test.tick();     // getLive() pauses the timer mid-call, THEN resolves not-live

  assert.equal(pauseCalls.length, 0,
    'a timer a scene paused mid-poll must never be pauseRetroactive-d — it was not a sustained LIVENESS outage');
  assert.equal(t.snapshot().running, false, 'the scene pause itself must still hold');
  assert.equal(t.snapshot().remainingSec, gapBefore,
    'no fabricated refund — the scene pause froze the clock; control(\'pause\') alone moved nothing further');
  assert.equal(t.snapshot().night.elapsedSec, elapsedBefore);

  // And liveness must not believe it now owns this pause: recovery must not
  // play OVER the pre-show scene.
  live = true;
  await nl.__test.tick();
  assert.equal(controlCalls.filter((a) => a[0] === 'play').length, 0,
    'liveness never paused this timer — the scene did — so liveness must not resume it');
  assert.equal(t.snapshot().running, false, 'the scene pause must still hold after liveness sees "live" again');
});

// ── The SECOND outage against the same anchor ───────────────────────────────
//
// `lastLiveMs` comes from the liveness source, and while the stream is STILL
// down it never moves — it is, by construction, the same instant on every poll
// of the outage. So anything that resumes the clock mid-outage (a scene flip
// back off the pre-show scene, a mod hitting play, an OBS scene sync at startup,
// a restart) sets up a SECOND sustained-outage decision that hands
// `pauseRetroactive` the very same anchor it was already paid against — and
// the refund would be paid twice. The ember would roll backward past truth:
// fabricated funded time, on the number the whole night is sold in.
//
// So the module remembers: the moment THIS module last paused is a floor under
// every later anchor, because nothing before it can still be owed.

test('a second sustained outage must not refund the SAME stretch again (resume-while-down, then re-pause)', async () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const realNow = Date.now();
  t.__test.st.updatedAt = realNow - 400_000;
  const lastLiveMs = realNow - 300_000; // the stream never came back: this never moves

  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs }),
    debounceMs: 120_000,
    nowFn,
  });

  await quietAsync(async () => {
    await nl.__test.tick();      // debounce starts
    nowFn.advance(120_000);
    await nl.__test.tick();      // first sustained pause — the honest 300s refund
  });
  const first = t.snapshot();
  assert.equal(first.running, false, 'premise: the first pause landed');
  assert.equal(Math.round(first.night.elapsedSec), 3700, 'premise: 300s came out of the ember');

  // Mid-outage, something else starts the clock again. Liveness still holds its
  // `pausedByLiveness` flag, and the stream is still down.
  t.control('play');

  await quietAsync(async () => {
    await nl.__test.tick();      // not live, running again → a fresh debounce
    nowFn.advance(120_000);
    await nl.__test.tick();      // sustained again → the second pause
  });

  const second = t.snapshot();
  assert.equal(second.running, false, 'the second outage must still pause the clock');
  assert.equal(Math.round(second.night.elapsedSec), Math.round(first.night.elapsedSec),
    'the ember rolled BACKWARD past truth — the same outage was refunded twice');
  assert.equal(Math.round(second.remainingSec), Math.round(first.remainingSec),
    'the gap grew by funded time nobody streamed');
});

test('the anchor handed to pauseRetroactive is never older than this module\'s own last pause', async () => {
  // The mechanism behind the test above, asserted directly: whatever the
  // liveness source says, the anchor is floored at the moment liveness itself
  // last paused. (`lastLiveMs` here is deliberately ancient — a session whose
  // final viewer_snapshots row is hours old.)
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const lastLiveMs = Date.now() - 3_600_000;
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs }),
    debounceMs: 120_000,
    nowFn,
  });

  await quietAsync(async () => {
    await nl.__test.tick();
    nowFn.advance(120_000);
    await nl.__test.tick();          // pause #1
    const firstPauseAt = nowFn();
    t.control('play');
    await nl.__test.tick();
    nowFn.advance(120_000);
    await nl.__test.tick();          // pause #2

    assert.equal(pauseCalls.length, 2, 'premise: two sustained-outage decisions fired');
    assert.equal(pauseCalls[0][0], lastLiveMs, 'the FIRST pause has no floor to apply — the source anchor stands');
    assert.ok(pauseCalls[1][0] >= firstPauseAt,
      `the second anchor (${pauseCalls[1][0]}) reached back before this module's own last pause (${firstPauseAt})`);
  });
});

test('a live read clears the pause floor — the NEXT outage anchors on the source again', async () => {
  // The floor is scoped to one unbroken outage. Once the stream is provably
  // live again, everything before that moment is settled and a later outage's
  // own `lastLiveMs` must be free to stand on its own.
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200 });
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  let live = false;
  let lastLiveMs = Date.now() - 300_000;
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs }),
    debounceMs: 120_000,
    nowFn,
  });

  await quietAsync(async () => {
    await nl.__test.tick();
    nowFn.advance(120_000);
    await nl.__test.tick();          // pause #1
    live = true;
    await nl.__test.tick();          // back live: resumed, and the floor is cleared

    live = false;
    lastLiveMs = Date.now() - 30_000; // a fresh outage with its own, NEWER anchor
    await nl.__test.tick();
    nowFn.advance(120_000);
    await nl.__test.tick();          // pause #2
  });

  assert.equal(pauseCalls.length, 2);
  assert.equal(pauseCalls[1][0], lastLiveMs,
    'after a live read the source anchor must stand — a stale floor would under-refund the new outage');
});

// ── THE RESET LOOP ──────────────────────────────────────────
// Off-air, with no open session (`liveState()` is `{live:false}`), the
// fallback anchor is the last viewer snapshot of a session that ended THE
// PREVIOUS DAY. Without arming, every `play` would run for the debounce and
// then `pauseRetroactive` would refund the whole running stretch — the clock
// snapping back to exactly its seed and stopping, over and over.
//
// An OUTAGE is a stream that WAS live during this night and isn't now. A
// night the stream has never been live during — an off-air test, a pre-show
// start before stream-ingest has opened the session, an ingest that is down
// — has nothing to refund. The watchdog must ARM on proof of life inside
// the night and stay inert before it.

test('THE RESET LOOP: a night the stream has never been live during is not an outage — the watchdog never touches it', async () => {
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 8273, seedSec: 7200 });
  t.__test.st.night.startedAt = new Date(Date.now() - 90_000);   // the night began 90s ago
  const yesterday = Date.now() - 30 * 3600_000;                   // the last proof of life: a session that ended a day ago
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const controlCalls = spyOn(t, 'control');
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs: yesterday }),
    debounceMs: 120_000,
    nowFn,
  });

  await quietAsync(async () => {
    for (let i = 0; i < 20; i++) { await nl.__test.tick(); nowFn.advance(30_000); } // ten minutes of polls
  });

  assert.equal(pauseCalls.length, 0, 'an off-air night must never be paused retroactively');
  assert.equal(controlCalls.length, 0, 'nor touched at all');
  assert.equal(t.snapshot().running, true, 'the clock the operator started is still running');
});

test('no session has ever existed (lastLiveMs null): same answer — nothing to refund, nothing paused', async () => {
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 8273, seedSec: 7200 });
  t.__test.st.night.startedAt = new Date(Date.now() - 90_000);
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs: null }),
    debounceMs: 120_000,
    nowFn,
  });
  await quietAsync(async () => {
    for (let i = 0; i < 10; i++) { await nl.__test.tick(); nowFn.advance(30_000); }
  });
  assert.equal(pauseCalls.length, 0);
  assert.equal(t.snapshot().running, true);
});

test('the watchdog ARMS on proof of life inside the night: pre-show it holds, a real drop after going live still pauses', async () => {
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 8273, seedSec: 7200 });
  const nightStart = Date.now() - 90_000;
  t.__test.st.night.startedAt = new Date(nightStart);
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  let live = false;
  let lastLiveMs = nightStart - 24 * 3600_000; // stale: yesterday's session
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs }),
    debounceMs: 120_000,
    nowFn,
  });

  await quietAsync(async () => {
    // pre-show: the night runs, ingest has not opened a session yet
    for (let i = 0; i < 6; i++) { await nl.__test.tick(); nowFn.advance(30_000); }
    assert.equal(pauseCalls.length, 0, 'pre-show must not pause');

    // on air
    live = true;
    await nl.__test.tick();

    // the stream drops; the DB's last proof of life is now INSIDE the night
    live = false;
    lastLiveMs = Date.now() - 45_000;
    await nl.__test.tick();          // debounce starts
    nowFn.advance(120_000);
    await nl.__test.tick();          // sustained: a real outage
  });

  assert.equal(pauseCalls.length, 1, 'a drop after the stream was live this night is a real outage');
  assert.equal(pauseCalls[0][0], lastLiveMs, 'anchored on the in-night proof of life');
});

test('a live read seen in-process arms the night even before the DB carries an in-night snapshot (drop in the first minute)', async () => {
  // The night was started ON AIR and the stream fell over 20s later — before
  // the viewer poller wrote a snapshot newer than night.startedAt. The DB
  // anchor is older than the night, but this process SAW the stream live
  // after the night began; that is proof enough.
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 8273, seedSec: 7200 });
  const nightStart = Date.now() - 20_000;
  t.__test.st.night.startedAt = new Date(nightStart);
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  let live = true;
  const staleAnchor = nightStart - 40_000; // the last snapshot predates the night
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: staleAnchor }),
    debounceMs: 120_000,
    nowFn,
  });
  await quietAsync(async () => {
    await nl.__test.tick();          // live, inside the night: armed
    live = false;
    await nl.__test.tick();          // debounce starts
    nowFn.advance(120_000);
    await nl.__test.tick();          // sustained
  });
  assert.equal(pauseCalls.length, 1, 'armed by the in-process live read');
});

test('a NEW night disarms: the previous night\'s proof of life does not carry over', async () => {
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 8273, seedSec: 7200 });
  t.__test.st.night.startedAt = new Date(Date.now() - 3600_000);
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  let live = true;
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs: Date.now() - 7200_000 }),
    debounceMs: 120_000,
    nowFn,
  });
  await quietAsync(async () => {
    await nl.__test.tick();          // live during night #1: armed
    // The streamer ends the stream and, still off-air, starts a fresh test night
    live = false;
    t.__test.st.night.startedAt = new Date(Date.now() - 1000);
    t.__test.st.night.elapsedSec = 0;
    for (let i = 0; i < 10; i++) { await nl.__test.tick(); nowFn.advance(30_000); }
  });
  assert.equal(pauseCalls.length, 0, 'night #2 was never live — the arm from night #1 must not fire on it');
});

// ── Edge cases of the arming rule ───────────────────────────────────────────

test('F-4: disarming must not drop pause OWNERSHIP — a night liveness paused is resumed when the stream returns, even after a new night', async () => {
  // Liveness paused night #1 mid-outage. The streamer, still off-air, opens night #2
  // (startNight leaves `running` as-is: false). One not-live tick disarms
  // (night #2 was never live). Then the stream comes back: the watchdog is
  // the one holding the pause, so it must release it — or the fuse sits
  // frozen for the rest of the stream until an OBS scene flip.
  const t = nightTimer({ gapSec: 6600, elapsedSec: 600, durationSec: 25200, seedSec: 7200 });
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  let live = false;
  let lastLiveMs = Date.now() - 45_000; // inside night #1
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs }),
    debounceMs: 120_000, nowFn,
  });
  await quietAsync(async () => {
    await nl.__test.tick(); nowFn.advance(120_000); await nl.__test.tick(); // paused by liveness
    assert.equal(pauseCalls.length, 1, 'premise: liveness holds the pause');
    assert.equal(t.snapshot().running, false);
    // night #2, off-air
    Object.assign(t.__test.st.night, { startedAt: new Date(), elapsedSec: 0 });
    lastLiveMs = Date.now() - 7200_000; // the DB's last proof of life predates night #2
    await nl.__test.tick(); nowFn.advance(30_000);            // the disarming tick
    live = true;
    await nl.__test.tick();                                    // the stream is back
  });
  assert.equal(t.snapshot().running, true, 'liveness paused it, liveness must resume it');
});

test('F-4b: the DB anchor going null mid-outage (a session with no snapshot yet) must not orphan a liveness pause', async () => {
  const t = nightTimer({ gapSec: 7140, elapsedSec: 60, durationSec: 25200, seedSec: 7200 });
  const nowFn = fakeClock();
  let live = false;
  let lastLiveMs = Date.now() - 30_000;
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => (live ? { live: true, lastLiveMs: null } : { live: false, lastLiveMs }),
    debounceMs: 120_000, nowFn,
  });
  await quietAsync(async () => {
    await nl.__test.tick(); nowFn.advance(120_000); await nl.__test.tick(); // paused
    assert.equal(t.snapshot().running, false, 'premise');
    lastLiveMs = null;
    await nl.__test.tick(); nowFn.advance(30_000);
    live = true;
    await nl.__test.tick();
  });
  assert.equal(t.snapshot().running, true, 'still owned, so resumed');
});

test('F-5: a night with NO start instant is DISARMED, never armed against yesterday', async () => {
  // Only a hand-edited row produces this — but permissive was the reset loop,
  // bit for bit, so the default is the other way round.
  const t = nightTimer({ gapSec: 6996, elapsedSec: 3600, durationSec: 21600, seedSec: 7200 });
  t.__test.st.night.startedAt = null;
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs: Date.now() - 24 * 3600_000 }),
    debounceMs: 120_000, nowFn,
  });
  await quietAsync(async () => {
    for (let i = 0; i < 10; i++) { await nl.__test.tick(); nowFn.advance(30_000); }
  });
  assert.equal(pauseCalls.length, 0);
  assert.equal(t.snapshot().running, true);
});

test('F-6: a drop inside the night\'s first minute IS protected — the DB anchor is read with the poller\'s own granularity', async () => {
  // The streamer opens the night while live; the newest viewer snapshot is 40s older than
  // the night (the poller writes one a minute); the stream drops before this
  // process ever reads live. Without the 90s allowance the watchdog could
  // never arm for the whole outage.
  const t = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 25200, seedSec: 7200 });
  const nightStart = Date.now() - 20_000;
  t.__test.st.night.startedAt = new Date(nightStart);
  const pauseCalls = spyOn(t, 'pauseRetroactive');
  const nowFn = fakeClock();
  const nl = createNightLiveness({
    timer: t,
    getLive: async () => ({ live: false, lastLiveMs: nightStart - 40_000 }),
    debounceMs: 120_000, nowFn,
  });
  await quietAsync(async () => {
    await nl.__test.tick(); nowFn.advance(120_000); await nl.__test.tick();
  });
  assert.equal(pauseCalls.length, 1, 'armed through the snapshot-granularity allowance');
  // …and the allowance is NOT a door for yesterday's anchor
  const t2 = nightTimer({ gapSec: 7200, elapsedSec: 0, durationSec: 25200, seedSec: 7200 });
  t2.__test.st.night.startedAt = new Date(Date.now() - 20_000);
  const pauseCalls2 = spyOn(t2, 'pauseRetroactive');
  const nl2 = createNightLiveness({ timer: t2, getLive: async () => ({ live: false, lastLiveMs: Date.now() - 20_000 - 91_000 }), debounceMs: 120_000, nowFn });
  await quietAsync(async () => { await nl2.__test.tick(); nowFn.advance(120_000); await nl2.__test.tick(); });
  assert.equal(pauseCalls2.length, 0, '91s before the night is outside the allowance');
});
