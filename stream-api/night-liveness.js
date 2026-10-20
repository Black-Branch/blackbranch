// ── Fund the Night: liveness pause (sustained, retroactive) ────────────────
//
// A night's `remaining_sec` is a countdown of STREAMED time, but timer.js has
// no way to know the stream actually dropped — its clock just keeps walking
// the ember forward every real second, live or not (that is what "running"
// means). Left alone, an outage during an active night silently spends funded
// time nobody watched: an hour offline is an hour of the frontier burned for
// nothing.
//
// This module is the watchdog. It polls the SAME liveness the site's
// `/stream/current` reads (index.js wires `getLive` from `lifecycle.liveState`
// plus a fallback query — see index.js's night-liveness wiring for exactly
// which anchor it uses and why), and on a SUSTAINED drop calls
// `timer.pauseRetroactive(sinceMs)` — not `control('pause')` — so the clock is
// corrected back to the last provably-live instant rather than frozen wherever
// it happens to sit after the debounce window also burned unpaid.
//
// ── The debounce ─────────────────────────────────────────────────────────
// A single missed poll is not an outage — it is network jitter, a slow query,
// a viewer-count platform hiccup. Only a liveness read that stays down for
// `debounceMs` (default 2 min, vs. a 30s poll) triggers a pause. Anything
// shorter is a FLAP: this module must not touch the timer for one at all —
// no pause, no resume, because it never paused in the first place.
//
// ── The anchor floor ─────────────────────────────────────────────────────
// One outage can produce TWO sustained-outage decisions if anything resumes
// the clock in between (scene flip, mod, restart). `lastLiveMs` does not move
// while the stream is down, so the second decision would re-anchor on the
// first one's instant and refund the same stretch twice. Every anchor is
// therefore floored at this module's own last pause — see `pauseAnchorMs`.
//
// ── Scene-pause vs. liveness-pause: two owners, one lock ────────────────────
// `timer.js` already pauses on OBS's pause scene (timer.pauseScene: BRB/Outro), and
// that pause and this one must never fight. The rule is a single internal
// flag, `pausedByLiveness`:
//   • this module only ever calls `timer.control('play')` to resume, and only
//     when IT was the one that paused (the flag is true) — a scene-paused
//     timer is left exactly alone in both directions: liveness will not pause
//     an already-paused timer further, and will not resume one it didn't stop.
//   • conversely, once liveness has paused a night, the timer sits at
//     `running: false` — indistinguishable from a scene pause by that field
//     alone, which is why the flag (not `timer.snapshot().running`) is what
//     gates the resume call.
//
// ── Arming: an outage needs a stream that WAS live ───────────────────────
// Not-live is not the same thing as an outage. A night the stream has never
// been live during — testing off-air, a pre-show start before stream-ingest has
// opened the session, an ingest that is simply down — has nothing to refund,
// and the fallback anchor would be the last proof of life of some EARLIER
// session. That anchor is older than the whole running stretch, so
// `pauseRetroactive` would hand back the entire stretch — ember to 0, clock to
// its seed, paused — minutes after every press of play, which reads as the
// timer resetting itself. The rule: the watchdog ARMS only on proof of life
// INSIDE this night —
// a live read seen by this process since `night.startedAtMs`, or a DB anchor
// (`lastLiveMs`) at or after it — and is inert before that. A new night (a new
// `startedAtMs`) disarms; the previous night's proof does not carry over.
//
// ── The fail-safe ────────────────────────────────────────────────────────
// `getLive()` reads the database. A database that is unreachable is NOT
// evidence the stream is down — it is evidence nothing is known — and pausing
// a running night on "I don't know" would freeze a perfectly healthy stream
// the moment Postgres hiccups. So an error or a nullish/malformed result is
// its own state, UNKNOWN: no action, and the pending debounce is thrown away
// (a stretch of unknown-state ticks must not silently count toward a real
// outage once the DB comes back — that would pause on the FIRST fresh
// not-live read, when in fact only a few seconds of PROVEN outage have
// elapsed since the query started working again).

'use strict';

// The viewer poller (stream-ingest) writes one `stream.viewer_snapshots` row a
// minute while live; the arming rule reads that anchor with this much slack.
const SNAPSHOT_GRANULARITY_MS = 90_000;

function createNightLiveness({
  timer, getLive, intervalMs = 30_000, debounceMs = 120_000, nowFn = Date.now,
} = {}) {
  let handle = null;
  let debounceStartMs = null; // set the tick a not-live read is first seen; null = no outage in progress
  let pausedByLiveness = false; // true only while THIS module is the one holding the timer paused
  // The moment THIS module last paused, and a FLOOR under every later
  // anchor. `lastLiveMs` cannot move while the stream is still down — it is the
  // same instant on every poll of one outage — so anything that resumes the
  // clock mid-outage (a scene flip back off the pause scene, a mod hitting
  // play, an OBS scene sync at startup) sets up a SECOND sustained-outage
  // decision that would hand `pauseRetroactive` the anchor it was already paid
  // against, and the same stretch would be refunded twice: the ember rolls
  // backward past truth, fabricating funded time on air. Nothing before this
  // module's own last pause can still be owed. Cleared on a live read, because
  // once the stream is provably back the next outage is a new debt with its own
  // honest anchor.
  let pauseAnchorMs = null;
  let unknownLogged = false; // log-once latch for the getLive()-failed state (not per tick)
  // The `night.startedAtMs` of the night during which this process last read
  // `live: true`; null = none. One half of the arming rule (module header) —
  // the half that covers a drop inside a night's first minute, before the
  // viewer poller has written a snapshot newer than the night itself.
  let liveSeenNightMs = null;
  let offAirLogged = false; // log-once latch for the disarmed (never-live) state, per night

  function onUnknown(err) {
    // Fail-safe: an unreadable liveness signal must never be treated as "not
    // live", and any debounce in progress is abandoned rather than merely
    // paused — see the module header. A running night is left running.
    debounceStartMs = null;
    if (!unknownLogged) {
      unknownLogged = true;
      console.warn(
        `[night-liveness] getLive() ${err ? `threw: ${err.message}` : 'returned an invalid result'}` +
        ' — holding, not pausing (fail-safe)'
      );
    }
  }

  async function tick() {
    const before = timer.snapshot();
    if (!before.night.active) {
      // Nothing to protect. Also clears state scoped to "this night" — a
      // pause flag left over from a night that has since ended must not
      // resume the NEXT one's timer for a reason that no longer applies.
      debounceStartMs = null;
      pausedByLiveness = false;
      pauseAnchorMs = null;
      liveSeenNightMs = null;
      offAirLogged = false;
      return;
    }

    // A timer that isn't running and that WE didn't stop is scene-paused (or
    // stopped for some other reason outside this module's business) — leave
    // it alone in both directions, and skip the liveness read entirely: with
    // `running` false and the flag false, neither branch below can act on
    // whatever `getLive()` would say, so there is nothing to spend a DB round
    // trip finding out.
    if (!before.running && !pausedByLiveness) {
      debounceStartMs = null;
      return;
    }

    let result;
    try {
      result = await getLive();
    } catch (e) {
      onUnknown(e);
      return;
    }
    if (result == null || typeof result.live !== 'boolean') {
      onUnknown(null);
      return;
    }
    unknownLogged = false; // a known read clears the log-once latch for the next failure
    const { live, lastLiveMs } = result;

    // RE-SAMPLE. `before` was read BEFORE the `await` above suspended this
    // function — a real `getLive()` is a DB round trip, and anything can
    // happen to the timer while this function is off the stack: in
    // particular, OBS can switch to the pause scene and scene-pause it. Every
    // decision from here on must act on what the timer is doing NOW, not on
    // `before`. Without this, a scene-pause landing mid-poll lets a
    // sustained-outage decision that was only true at tick-START fire
    // `pauseRetroactive` on a timer the scene already stopped — wrongly
    // claiming liveness ownership (and later resuming OVER the scene), and
    // (see timer.js's own not-running guard) asking for a refund against an
    // `elapsedSec` that has sat frozen since the scene pause landed, which
    // would grow with however long this tick took rather than with any real
    // outage.
    const now = timer.snapshot();
    if (!now.night.active) {
      // the night ended while this tick was waiting on getLive()
      debounceStartMs = null;
      pausedByLiveness = false;
      pauseAnchorMs = null;
      liveSeenNightMs = null;
      offAirLogged = false;
      return;
    }

    const startedAtMs = now.night.startedAtMs ?? null;
    if (live) {
      debounceStartMs = null; // any outage in progress is over, flap or real
      pauseAnchorMs = null;   // provably live: nothing before now is still owed
      liveSeenNightMs = startedAtMs ?? 0; // armed for THIS night (module header)
      offAirLogged = false;
      if (pausedByLiveness) {
        timer.control('play');
        pausedByLiveness = false;
        console.log('[night-liveness] liveness restored — resuming (it was liveness that paused)');
      }
      return;
    }

    // Not live — but is it an OUTAGE? Only if the stream has been live
    // during THIS night (module header: "Arming"). A never-live night is left
    // exactly alone, and everything scoped to an outage is cleared, because
    // there isn't one: a pause flag or anchor floor inherited from an earlier
    // night's real outage describes a debt this night does not owe.
    //
    // Clause 2 reads the DB anchor with the viewer poller's own granularity
    // (one snapshot a minute): a night opened on air whose stream drops in its
    // first seconds has a newest snapshot up to ~60s OLDER than the night, and
    // without the allowance the watchdog could never arm for that whole
    // outage. 90s covers it; a day-old anchor stays a day out.
    //
    // A night with NO start instant is DISARMED. Only a hand-edited row
    // produces one, and arming there would refund against yesterday's anchor
    // and hand back the whole run.
    const armed =
      (liveSeenNightMs != null && liveSeenNightMs === (startedAtMs ?? 0)) ||
      (startedAtMs != null && lastLiveMs != null && lastLiveMs >= startedAtMs - SNAPSHOT_GRANULARITY_MS);
    if (!armed) {
      // Outage-scoped state only. `pausedByLiveness` is NOT cleared here: an
      // un-armed night is a night with nothing to refund, not a night this
      // module stopped owning — and the live branch above is the only thing
      // that releases a pause it holds. Clearing it here would leave a
      // liveness-paused night frozen for the rest of the stream when a new
      // night is opened mid-outage, or when the DB anchor goes null for one
      // tick.
      debounceStartMs = null;
      pauseAnchorMs = null;
      if (!offAirLogged) {
        offAirLogged = true;
        console.log('[night-liveness] not live, and the stream has not been live during this night — nothing to pause (arms on the first live read)');
      }
      return;
    }

    // Not live. If liveness already paused this night, there is nothing left
    // to do but keep waiting for `live` to come back true, above. Reading
    // `now.running` (not `before.running`) is what makes this the same guard
    // that protects a scene-paused timer above, but re-checked post-await —
    // a scene pause landing during THIS getLive() call reads as `!now.running`
    // here even though `before.running` was true when the tick started.
    if (!now.running) {
      if (!pausedByLiveness) debounceStartMs = null;
      return;
    }

    if (debounceStartMs == null) {
      debounceStartMs = nowFn();
      console.log('[night-liveness] liveness lost — starting the debounce');
      return;
    }
    if (nowFn() - debounceStartMs >= debounceMs) {
      // Sustained: correct the clock back to the last provably-live instant,
      // not to now — see timer.js's pauseRetroactive() for the accumulator
      // math. Falls back to when the debounce itself started if the liveness
      // source has no better anchor (a cold session with no snapshot yet).
      // `now.running` was just re-confirmed above (no further await between
      // there and here), so this is not acting on stale state.
      //
      // …and never reaches back past our OWN last pause (see
      // `pauseAnchorMs`): that stretch is settled, and re-anchoring on a
      // `lastLiveMs` frozen at the start of a still-running outage would refund
      // it a second time.
      timer.pauseRetroactive(Math.max(lastLiveMs ?? debounceStartMs, pauseAnchorMs || 0));
      pausedByLiveness = true;
      pauseAnchorMs = nowFn();
      debounceStartMs = null;
      console.log('[night-liveness] sustained outage — paused retroactively');
    }
  }

  function start(ms = intervalMs) {
    if (handle) return handle; // idempotent — a second start() must not leak a second interval
    handle = setInterval(() => {
      tick().catch((e) => console.warn('[night-liveness] tick failed:', e.message));
    }, ms);
    if (handle.unref) handle.unref();
    return handle;
  }
  function stop() {
    if (handle) { clearInterval(handle); handle = null; }
  }

  return {
    start, stop,
    __test: { tick },
  };
}

module.exports = { createNightLiveness };
