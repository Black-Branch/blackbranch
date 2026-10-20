// Server-authoritative stream timer. stream-api holds the countdown and its
// config, persists both to stream.timer_state, and broadcasts a full
// `timerState` snapshot that the site and the OBS overlay render. Marathon
// mode = cap disabled.
//
//   - money -> time: addMoney() converts take-home $ to seconds at usd_per_hour.
//   - commands: adjust, set, control, reset and setConfig, called by the
//     /timer/* HTTP endpoints in money.js (the website's mod tools).
//   - scene pause: pauses on the pause scene (timer.pauseScene), plays otherwise.
//
// Persistence: while running, live remaining = remaining_sec - (now -
// updated_at); every mutation re-anchors both. On startup the anchor is reset
// to now, so downtime is never counted against the clock.
//
// ── Fund the Night ─────────────────────────────────────────────────────────
// A night is a fixed stretch of streamed time that donations pay for block by
// block. While one is active `remaining_sec` is a GAP (funded frontier minus
// now) and may go NEGATIVE: the deficit is unpaid streamed time, which is what
// the fuse overlay shows. Every zero floor on the clock is therefore
// night-conditional: with no night active they behave as a plain countdown,
// because the overlay, the site's timer libs and the support-bar math never
// floor a negative `remainingSec` themselves.
//
// One anchor, two accumulators: `updatedAt` drives both the gap and
// `night.elapsedSec`, which move in opposite directions by the same dt. Their
// sum is the frontier, so re-anchoring conserves it; only money moves it.
//
// The lifecycle and the money->time conversion live here; the pricing lives in
// `night-math.js`, a pure core with no clock or database so every case in it is
// hand-verifiable. This module owns `now`, the anchor and the persistence.

'use strict';

const {
  convertCents, drainOverflow, extendBlocks, layoutBlocks, nightPriceCents,
} = require('./night-math');
// Two free hours open every night unless the start call says otherwise. A
// constant, not the persisted per-night seed (see startNight).
const NIGHT_SEED_DEFAULT_SEC = 7200;

const { instanceConfig } = require('./instance-config');
// Instance key timer.pauseScene (env TIMER_PAUSE_SCENE), read per scene change. Unset = scene
// changes leave the timer alone.
const pauseScene = () => instanceConfig.get('timer.pauseScene') || null;

// Parse "2h23m14s" → seconds. All components optional; a bare number = seconds.
function parseDuration(input) {
  if (input == null) return 0;
  let h = 0, m = 0, s = 0, num = 0, hasDigit = false;
  for (const c of String(input).toLowerCase()) {
    if (c >= '0' && c <= '9') { num = num * 10 + (c.charCodeAt(0) - 48); hasDigit = true; }
    else if (c === 'h' && hasDigit) { h = num; num = 0; hasDigit = false; }
    else if (c === 'm' && hasDigit) { m = num; num = 0; hasDigit = false; }
    else if (c === 's' && hasDigit) { s = num; num = 0; hasDigit = false; }
  }
  if (hasDigit && h === 0 && m === 0 && s === 0) s = num; // bare number → seconds
  return h * 3600 + m * 60 + s;
}

// ── Fund the Night: an end time -> a streamed duration ──────────────────────
//
// The streamer sets an END TIME in local time ("ending at 4am"); the night is a
// DURATION in streamed seconds. The conversion happens once, at start:
// wall-clock anchoring would burn paid time through an outage.

/**
 * A bad night configuration, thrown rather than defaulted: a night opened
 * against a misread end time is worse than no night at all (it would price
 * hours nobody agreed to). Carries `code` so the route can turn it into a 400
 * instead of a 500.
 */
class NightConfigError extends Error {
  constructor(message, code = 'INVALID_END_LOCAL') {
    super(message);
    this.name = 'NightConfigError';
    this.code = code;
  }
}

// "+8h" / "+2.5h" — the duration stated directly (marathons-with-an-end, tests).
const REL_END = /^\+\s*(\d+(?:\.\d+)?)\s*h$/;
// "4am" · "4:30am" · "04:30" · "23:00" — a local time of day.
const ABS_END = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

// One formatter per zone, built once: `formatToParts` is the only dependency-free
// way to ask what the wall clock reads in another timezone, and constructing an
// Intl.DateTimeFormat is expensive enough to be worth the map.
const tzFormatters = new Map();
function tzFields(ms, tz) {
  let fmt = tzFormatters.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch {
      throw new NightConfigError(`startNight: unknown timezone "${tz}"`, 'INVALID_TZ');
    }
    tzFormatters.set(tz, fmt);
  }
  const out = {};
  for (const part of fmt.formatToParts(ms)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  // `hourCycle: 'h23'` makes midnight 0; the modulo covers ICU builds that
  // return 24 anyway. 24 on the new day's date would be a full day off. The
  // midnight test in timer.test.js guards it on builds that need it.
  out.hour %= 24;
  return out;
}

/** How far `tz` is from UTC at that instant, in ms (DST included, by definition). */
function tzOffsetMs(ms, tz) {
  const p = tzFields(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    - Math.floor(ms / 1000) * 1000; // formatToParts has no sub-second to give
}

/**
 * The next instant at which `tz`'s wall clock reads `hour:minute`. "Next" is
 * strict: 4am at 4am means tomorrow's 4am, never a zero-length night.
 *
 * Two passes: the offset in force now is wrong across a DST boundary (on a
 * fall-back night 23:30 to 4am is 4.5 wall hours and 5.5 real ones), and the
 * night is sold in real seconds. So the offset is re-derived at the guessed
 * instant and the guess redone against it.
 */
function nextLocalTime(hour, minute, tz, nowMs) {
  const p = tzFields(nowMs, tz);
  for (let addDays = 0; addDays <= 2; addDays++) {
    const wallMs = Date.UTC(p.year, p.month - 1, p.day + addDays, hour, minute, 0);
    let ms = wallMs - tzOffsetMs(nowMs, tz);
    ms = wallMs - tzOffsetMs(ms, tz);
    if (ms > nowMs) return ms;
  }
  // Unreachable for a real zone (a time of day recurs every 24h); a loud throw
  // beats a night of some arbitrary length if one ever manages it.
  throw new NightConfigError(`startNight: no next occurrence of ${hour}:${minute} in "${tz}"`);
}

/**
 * `endLocal` → the night's length in seconds. Throws `NightConfigError` on
 * anything it cannot read; a guess here is a mispriced night.
 *
 * @param {string} endLocal "4am" | "4:30am" | "04:30" | "+8h"
 * @param {string|undefined} tz IANA zone, or undefined for the system zone
 * @param {number} nowMs the wall clock to measure from
 */
function nightDurationSec(endLocal, tz, nowMs) {
  const raw = String(endLocal == null ? '' : endLocal).trim().toLowerCase();
  if (!raw) throw new NightConfigError('startNight: endLocal is required ("4am", "04:30" or "+8h")');

  const rel = REL_END.exec(raw);
  if (rel) {
    const secs = Math.round(Number(rel[1]) * 3600);
    if (!(secs > 0)) throw new NightConfigError(`startNight: "${endLocal}" is a zero-length night`);
    return secs;
  }

  const abs = ABS_END.exec(raw);
  if (!abs) throw new NightConfigError(`startNight: could not parse endLocal "${endLocal}"`);
  let hour = Number(abs[1]);
  const minute = abs[2] == null ? 0 : Number(abs[2]);
  const meridiem = abs[3];
  // A bare hour is refused, as `setConfig` refuses a bare cap: "4" is 4am or
  // 4pm, a twelve-hour error that would mis-price every block of the night.
  if (!meridiem && abs[2] == null) {
    throw new NightConfigError(
      `startNight: "${endLocal}" is ambiguous — say "4am" or "04:00"`);
  }
  if (minute > 59) throw new NightConfigError(`startNight: "${endLocal}" has no such minute`);
  if (meridiem) {
    if (hour < 1 || hour > 12) throw new NightConfigError(`startNight: "${endLocal}" has no such hour`);
    hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0); // 12am → 0, 12pm → 12
  } else if (hour > 23) {
    throw new NightConfigError(`startNight: "${endLocal}" has no such hour`);
  }
  return Math.round((nextLocalTime(hour, minute, tz, nowMs) - nowMs) / 1000);
}

// `getBarTotal` is a late-bound getter, not a value: supportBar already depends
// on timer (earnTime -> addMoney), so a direct reference back would be a cycle.
//
// The bar total rides the timerState snapshot because `updateSupportBar` fires
// only on a contribution; the 15s timerState heartbeat lets a viewer who loads
// mid-stream see the bar without waiting for the next donation.
function createTimer({ broadcast, obs, pool, lights = null, getBarTotal = () => 0 }) {
  // In-memory authoritative state, loaded from the DB by init(). These defaults
  // apply to a fresh database.
  const st = {
    running: false,
    remainingSec: 10800,      // 3h base
    updatedAt: Date.now(),    // ms anchor for remainingSec
    // In memory only: when the current unbroken running stretch began (null
    // while paused). A restart is a new stretch by definition, so init() sets it
    // rather than loading it. `updatedAt` cannot stand in: every mutation
    // re-anchors mid-stretch. Read by pauseRetroactive() alone.
    runningSinceMs: null,
    capEnabled: true,
    capSec: 28800,            // 8h ceiling
    usdPerHour: 40,
    fillUsd: 200,
    baseSec: 10800,
    // Lock + the low-timer effects curve. These ride the timerState frame so the
    // site and the OBS overlay cannot disagree about them.
    lockAtZero: false,
    lowPulseEnabled: true,
    lowThresholdSec: 300,
    lowRampRate: 1.6,
    lowGlowMax: 0.55,
    // The night. Persisted whole; with `active: false` every number here is
    // inert and the timer is a plain countdown.
    night: {
      active: false,
      durationSec: 0,      // the whole night, in streamed seconds
      elapsedSec: 0,       // how much of it has been streamed (the ember)
      seedSec: NIGHT_SEED_DEFAULT_SEC, // free pre-funded territory at the top of the night
      priceCents: 0,       // the night's whole price, spread over the blocks
      blocks: null,        // night-math layout: [{startSec, lenSec, cents}]
      overflowCents: 0,    // money banked past the ceiling, awaiting an encore
      startedAt: null,     // Date | null
    },
  };

  // ── The clock: one anchor, two accumulators ───────────────────────────────
  //
  // `liveGap` has no zero floor: below zero the night is being streamed unpaid,
  // and a clamp here would forgive the deficit on every read.
  //
  // The zero floors on the clock are all night-conditional (marathon keeps its
  // floor, a night gets none):
  //
  //   wireRemaining()   the wire + the DB row
  //   clampRemaining()  every mutation
  //   reanchor()        banking the accumulators
  //   applyRow()        the load
  //
  // The other `Math.max(0` uses are not floors on the live clock:
  // snapshot().deficitSec (the magnitude of a negative gap), endNight() (the
  // deficit dies with the night) and startNight() (input hygiene on seedSec).
  // The night's own floor is `nightFloor()`, which is not zero and may sit
  // deeply negative.
  function liveGap() {
    if (!st.running) return st.remainingSec;
    return st.remainingSec - (Date.now() - st.updatedAt) / 1000;
  }
  // The ember: streamed seconds into the night. It advances only while a night
  // is running and is otherwise frozen, never zeroed: `reanchor()` and
  // `persist()` both write what this returns, so a `return 0` on an inactive
  // night would erase the night's record of how long it ran.
  function liveElapsed() {
    if (!st.night.active || !st.running) return st.night.elapsedSec;
    return st.night.elapsedSec + (Date.now() - st.updatedAt) / 1000;
  }
  /**
   * The single definition of the frontier: how far into the night is funded.
   * Conserved by reanchor; only money moves it. Meaningful only while a night
   * is active.
   *
   * Built on the wire gap, not the raw one. They are equal during a night;
   * outside one the wire floor keeps the snapshot's night block consistent with
   * the `remainingSec` on the same frame.
   */
  function frontierSec() { return liveElapsed() + wireRemaining(); }
  // `remainingSec` as the wire and the DB row mean it. Outside a night it is
  // floored at zero, because the consumers of this number render a negative as
  // garbage and none of them clamp.
  function wireRemaining() { return st.night.active ? liveGap() : Math.max(0, liveGap()); }

  // The ceiling on the gap. During a night it is the unsold territory: the
  // frontier may reach the end of the night and no further (an encore grows
  // `durationSec` instead). Outside one it is the marathon cap.
  const ceiling = () => (st.night.active
    ? st.night.durationSec - liveElapsed()
    : (st.capEnabled ? st.capSec : Infinity));
  // The night's own floor: a frontier of exactly `seedSec`. The seed is free
  // territory nobody bought, so a mod subtraction may not pull the frontier
  // under it; night-math refuses to convert from below the first sellable block,
  // so the next donation would throw in the money path.
  //
  // This goes negative once the ember passes the seed, which is correct: the
  // deficit below it is allowed.
  const nightFloor = () => st.night.seedSec - liveElapsed();
  // During a night zero is a crossing, not a boundary; the bounds are the sold
  // territory, frontier in [seedSec, durationSec], stated as a gap. Ceiling
  // last, so a night whose seed covers the whole clock cannot overhang its end.
  const clampRemaining = (sec) => (st.night.active
    ? Math.min(Math.max(sec, nightFloor()), ceiling())
    : Math.max(0, Math.min(sec, ceiling())));
  // Bank both accumulators into the anchor (call before toggling running or
  // mutating either, so elapsed real time isn't lost/double-counted).
  function reanchor() {
    const gap = liveGap();
    const elapsed = liveElapsed();
    st.remainingSec = st.night.active ? gap : Math.max(0, gap); // marathon keeps its floor
    st.night.elapsedSec = elapsed;
    st.updatedAt = Date.now();
  }

  // Two independent locks, both meaning "time can no longer increase":
  //   ceiling — at/above the cap (the overlay's existing "Time Maxed" badge)
  //   floor   — at zero with lockAtZero on (the marathon has ended)
  // Evaluated live, never stored: turning lockAtZero off grants grace
  // retroactively. Both read the raw gap; a negative gap answers `<= 0` and
  // `>= capSec` the same way zero does.
  //
  // `atFloor` is false whenever a night is active, whatever the stored
  // lockAtZero says: the floor lock would refuse the donation that pays off a
  // deficit. `startNight` clears the flag too, but a row loaded mid-night never
  // went through it.
  //
  // During a night the ceiling is the end of the night, so
  // `frontier >= durationSec` means fully funded. `snapshot()` does not ship
  // that as `locked` (a funded night still takes money; `night.funded` carries
  // it), but `atCeiling()` stays night-aware so any consumer gets the right
  // answer.
  //
  // Neither lock refuses MONEY: money is never refused, only time. `addMoney`
  // at a funded night banks to overflow.
  function atCeiling() {
    return st.night.active
      ? frontierSec() >= st.night.durationSec
      : (st.capEnabled && liveGap() >= st.capSec);
  }
  function atFloor()   { return !st.night.active && st.lockAtZero && liveGap() <= 0; }
  function isLocked()  { return atCeiling() || atFloor(); }

  /**
   * The frontier as night-math must receive it: `frontierSec()` with one
   * defensive snap.
   *
   * `(gap - dt) + (elapsed + dt)` is conserved only to within a floating-point
   * ULP, so a frontier sitting exactly on `seedSec` can land a hair below the
   * first sellable block, and `convertCents` throws on that rather than price
   * the free seed. Anything further below still reaches the throw: at that
   * distance it is a caller bug.
   *
   * The 50ms window is far wider than the observed float dust and far narrower
   * than the smallest real violation (a one-second subtraction past the floor);
   * timer.test.js pins the boundary from each side.
   */
  const DUST_SEC = 0.05;
  function conversionFrontier() {
    const f = frontierSec();
    const blocks = st.night.blocks;
    if (!blocks || !blocks.length) return f;
    const first = blocks[0].startSec;
    return f < first && first - f < DUST_SEC ? first : f;
  }

  function snapshot(deltaSec = 0) {
    // The wire gap, not the raw one, and the whole night block derives from it
    // (via frontierSec(), so the frontier has one definition). With no night the
    // wire floor keeps the block consistent: a countdown 90s past zero must not
    // ship `deficitSec: 90` on a frame whose `remainingSec` says 0.
    const gap = wireRemaining();
    const elapsed = liveElapsed();
    const frontier = frontierSec();
    // The frontier ships rounded, so every verdict drawn from it uses the
    // rounded number too. The raw float can land a hair under the end of the
    // night, which would ship the full `frontierSec` alongside `funded: false`
    // on the same frame.
    const frontierRounded = Math.round(frontier);
    const nightDurationRounded = Math.round(st.night.durationSec);
    return {
      type: 'timerState',
      running: st.running,
      remainingSec: Math.round(gap),
      capEnabled: st.capEnabled,
      capSec: st.capSec,
      usdPerHour: st.usdPerHour,
      fillUsd: st.fillUsd,
      baseSec: st.baseSec,
      deltaSec: Math.round(deltaSec), // >0/<0 drives the overlay's +/- popup; 0 = silent (heartbeat)
      lockAtZero: st.lockAtZero,
      lowPulseEnabled: st.lowPulseEnabled,
      lowThresholdSec: st.lowThresholdSec,
      lowRampRate: Number(st.lowRampRate),
      lowGlowMax: Number(st.lowGlowMax),
      // The support bar's running $ total. Coerced so a getter that returns
      // undefined can never put NaN on the wire.
      barTotal: Number(getBarTotal()) || 0,
      // Derived: cap ceiling OR zero floor, and night-exempt. The site renders
      // `locked` as a marathon padlock; a fully funded night still accepts money
      // (it banks for an encore), so it signals through `night.funded` instead.
      locked: isLocked() && !st.night.active,
      // The night, for the fuse overlay and the site. Additive: an overlay that
      // knows nothing of nights keeps rendering the fields above.
      night: {
        active: st.night.active,
        durationSec: nightDurationRounded,
        elapsedSec: Math.round(elapsed),
        gapSec: Math.round(gap),
        seedSec: Math.round(st.night.seedSec),
        frontierSec: frontierRounded,
        // Gated on `active`: with no night `durationSec` is 0, so the bare
        // comparison would mark every marathon frame funded.
        funded: st.night.active && frontierRounded >= nightDurationRounded,
        // Not a clamp: the magnitude of a negative gap, 0 when in the black.
        deficitSec: Math.round(Math.max(0, -gap)),
        // When this night began (ms epoch); null with no night. night-liveness.js
        // uses it to tell an outage (the stream was live during this night and is
        // not now) from a night that has never been live, which has nothing to
        // refund; without it an off-air night would be repeatedly rewound to its
        // seed.
        startedAtMs: st.night.startedAt ? st.night.startedAt.getTime() : null,
      },
    };
  }
  const config = () => ({
    capEnabled: st.capEnabled, capSec: st.capSec,
    usdPerHour: st.usdPerHour, fillUsd: st.fillUsd,
    lockAtZero: st.lockAtZero,
    lowPulseEnabled: st.lowPulseEnabled,
    lowThresholdSec: st.lowThresholdSec,
    lowRampRate: Number(st.lowRampRate),
    lowGlowMax: Number(st.lowGlowMax),
  });

  // True only while init() is retrying a read that FAILED — see init().
  let loadRetrying = false;

  async function persist() {
    if (!pool) return;
    // While the load is retrying the in-memory state is the coded defaults, and
    // writing them would overwrite the row the retry is trying to read. The
    // heartbeat runs on its own clock, so its first tick after the database
    // returns could land before the read does.
    if (loadRetrying) return;
    try {
      await pool.query(
        `UPDATE stream.timer_state
           SET running=$1, remaining_sec=$2, cap_enabled=$3, cap_sec=$4,
               usd_per_hour=$5, fill_usd=$6, base_sec=$7,
               lock_at_zero=$8, low_pulse_enabled=$9, low_threshold_sec=$10,
               low_ramp_rate=$11, low_glow_max=$12,
               night_active=$13, night_duration_sec=$14, night_elapsed_sec=$15,
               night_seed_sec=$16, night_price_cents=$17, night_blocks=$18,
               night_overflow_cents=$19, night_started_at=$20, updated_at=now()
         WHERE id=1`,
        [st.running, Math.round(wireRemaining()), st.capEnabled, st.capSec,
         st.usdPerHour, st.fillUsd, st.baseSec,
         st.lockAtZero, st.lowPulseEnabled, st.lowThresholdSec,
         st.lowRampRate, st.lowGlowMax,
         st.night.active, Math.round(st.night.durationSec), Math.round(liveElapsed()),
         Math.round(st.night.seedSec), Math.round(st.night.priceCents),
         // JSON.stringify, not the array itself: node-pg serializes a JS
         // ARRAY as a Postgres array literal (`{...}`), which jsonb rejects.
         st.night.blocks ? JSON.stringify(st.night.blocks) : null,
         Math.round(st.night.overflowCents), st.night.startedAt]
      );
    } catch (e) { console.warn('[timer] persist failed:', e.message); }
  }
  // Heartbeat change-detection: the serialized last-known
  // state, always keyed with deltaSec 0 — the popup is a one-shot property of
  // a mutation's own broadcast, never part of "did the state change".
  let hbKey = null;
  let hbSkipped = 0;
  const HB_RESYNC_EVERY = 4; // paused: still broadcast every 4th tick (60s at 15s ticks)

  function emit(deltaSec = 0) {
    const frame = snapshot(deltaSec);
    broadcast(frame);
    persist();
    hbKey = JSON.stringify(deltaSec === 0 ? frame : { ...frame, deltaSec: 0 });
    hbSkipped = 0;
  }

  // One heartbeat tick. Change → broadcast + persist, as ever. Unchanged →
  // skip, EXCEPT every HB_RESYNC_EVERY-th tick still broadcasts (no persist):
  // the heartbeat exists for a (re)connecting overlay whose timerState aged
  // out of the WS replay buffer, and skipping forever would strand it — 60s
  // bounds its wait, while a paused overnight timer stops writing the DB
  // ~5,760 times a day to re-state itself.
  function heartbeatTick() {
    const frame = snapshot();
    const key = JSON.stringify(frame);
    if (key !== hbKey) {
      broadcast(frame);
      persist();
      hbKey = key;
      hbSkipped = 0;
      return;
    }
    hbSkipped += 1;
    if (hbSkipped >= HB_RESYNC_EVERY) {
      hbSkipped = 0;
      broadcast(frame);
    }
  }

  // Defensive, not decorative: against a database older than the night columns
  // these are undefined, and Number(undefined) is NaN — which would ride the
  // timerState frame out to every viewer and poison the effects math. Keep the
  // coded defaults in that case.
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  // jsonb comes back already parsed from node-pg; a `json`-typed column, a
  // different driver or a fixture handing back the raw text must not leave
  // `blocks` as a STRING that the night math would then iterate character by
  // character.
  function parseBlocks(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : null; }
      catch { return null; }
    }
    return null;
  }
  function parseTs(v) {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function applyRow(row) {
    st.running      = row.running;
    const nightActive = typeof row.night_active === 'boolean' ? row.night_active : false;
    // The load clamp is night-conditional. A cold night's stored gap is
    // NEGATIVE, and flooring it here would forgive the whole deficit on every
    // restart — the one place a crash could quietly pay off the night's debt.
    st.remainingSec = nightActive
      ? Number(row.remaining_sec)
      : Math.max(0, Number(row.remaining_sec));
    st.capEnabled   = row.cap_enabled;
    st.capSec       = Number(row.cap_sec);
    st.usdPerHour   = Number(row.usd_per_hour) || 40;
    st.fillUsd      = Number(row.fill_usd) || 200;
    st.baseSec      = Number(row.base_sec);
    st.lockAtZero      = typeof row.lock_at_zero === 'boolean' ? row.lock_at_zero : false;
    st.lowPulseEnabled = typeof row.low_pulse_enabled === 'boolean' ? row.low_pulse_enabled : true;
    st.lowThresholdSec = num(row.low_threshold_sec, 300);
    st.lowRampRate     = num(row.low_ramp_rate, 1.6);
    st.lowGlowMax      = num(row.low_glow_max, 0.55);
    st.night.active        = nightActive;
    st.night.durationSec   = num(row.night_duration_sec, 0);
    st.night.elapsedSec    = num(row.night_elapsed_sec, 0);
    st.night.seedSec       = num(row.night_seed_sec, 7200);
    st.night.priceCents    = num(row.night_price_cents, 0);
    st.night.blocks        = parseBlocks(row.night_blocks);
    st.night.overflowCents = num(row.night_overflow_cents, 0);
    st.night.startedAt     = parseTs(row.night_started_at);
  }

  const LOAD_RETRY_MS = 5000;

  async function init({ retryMs = LOAD_RETRY_MS } = {}) {
    if (pool) {
      // A failed read is not an empty one. Until this query returns we cannot
      // know whether a night is in progress, and carrying on with the defaults
      // would open a fresh marathon over a half-funded night — rope, deficit
      // and overflow fund gone, made permanent by the first persist. So a throw
      // retries forever. A successful read with no row still takes the
      // defaults: an empty table is an answer, the one a fresh database gives.
      for (;;) {
        try {
          const r = await pool.query(`SELECT * FROM stream.timer_state WHERE id=1`);
          if (r.rows[0]) applyRow(r.rows[0]);
          break;
        } catch (e) {
          loadRetrying = true;
          console.warn(`[timer] load failed (retry in ${retryMs}ms, NOT defaulting):`, e.message);
          await new Promise((resolve) => setTimeout(resolve, retryMs));
        }
      }
      loadRetrying = false;
    }
    st.updatedAt = Date.now(); // don't count downtime across a restart
    // A restart is a NEW running stretch by definition — the process was not
    // running the clock while it was down, and the line above says exactly that
    // about the anchor. Set here rather than in applyRow() because the row
    // cannot know it: `running` survives, the stretch does not.
    st.runningSinceMs = st.running ? Date.now() : null;
    const n = st.night;
    const nightDesc = n.active
      ? `on ${Math.round(n.durationSec)}s elapsed=${Math.round(n.elapsedSec)}s ` +
        `seed=${Math.round(n.seedSec)}s blocks=${n.blocks ? n.blocks.length : 0} ` +
        `price=${Math.round(n.priceCents)}c overflow=${Math.round(n.overflowCents)}c`
      : 'off';
    console.log(`[timer] loaded running=${st.running} remaining=${Math.round(st.remainingSec)}s cap=${st.capEnabled ? st.capSec + 's' : 'off'} $${st.usdPerHour}/hr fill=$${st.fillUsd} night=${nightDesc}`);
    emit();
  }

  // ── mutations ─────────────────────────────────────────────────────────────
  // !a (sign +1) / !s (sign -1): relative adjust. Returns applied seconds (signed).
  function adjust(rawInput, sign = 1) {
    const seconds = parseDuration(rawInput);
    if (seconds <= 0) return 0;
    // Floor lock: at zero the marathon is over — added time is refused, but
    // subtraction still works (a mod can always take time away).
    if (sign > 0 && atFloor()) return 0;
    reanchor();
    const before = st.remainingSec;
    st.remainingSec = clampRemaining(st.remainingSec + seconds * (sign < 0 ? -1 : 1));
    const applied = st.remainingSec - before;
    emit(applied);
    return Math.round(applied);
  }
  // !set: absolute remaining time.
  function set(rawInput) {
    const seconds = parseDuration(rawInput);
    if (seconds <= 0) return 0;
    reanchor();
    st.remainingSec = clampRemaining(seconds);
    emit();
    return Math.round(st.remainingSec);
  }
  // !start / !pause (or scene-driven).
  function control(action) {
    if (action !== 'play' && action !== 'pause') return false;
    // Both branches re-anchor: on a paused clock that is a no-op on the values
    // and a reset of `updatedAt`, which is exactly what un-pausing needs (the
    // paused wall time must not land on the gap or on the ember).
    // Both branches also move `runningSinceMs`, and only on a real
    // TRANSITION: a redundant `play` returns above without restarting the
    // stretch, which is what makes "how long has it been running" answerable
    // at all (applyScene fires on every scene change, not just the two that
    // matter).
    if (action === 'pause' && st.running) {
      reanchor(); st.running = false; st.runningSinceMs = null; emit();
    } else if (action === 'play' && !st.running) {
      reanchor(); st.running = true; st.runningSinceMs = Date.now(); emit();
    }
    return true;
  }
  // Take-home $ → seconds. During a night that is the CURVE (night-math), not
  // the flat rate; with no night it is the flat marathon conversion. Returns
  // seconds actually added (capped).
  function addMoney(takeHome) {
    const usd = Number(takeHome) || 0;
    // `|| 0` catches NaN; Infinity gets through it and would bank an infinite
    // overflow that wedges every later persist() (int4 column). Not money, so
    // nothing.
    if (!Number.isFinite(usd) || usd <= 0) return 0;
    if (st.night.active) return addMoneyNight(usd);
    if (st.usdPerHour <= 0) return 0;
    // Returning 0 here refuses TIME ONLY. The caller (supportbar.add) has
    // ALREADY bumped and broadcast the bar total before reaching this point —
    // never turn this into an early return that skips the bank.
    // See timer-lock-policy.test.js.
    if (atFloor()) return 0;
    reanchor();
    const before = st.remainingSec;
    st.remainingSec = clampRemaining(st.remainingSec + (usd / st.usdPerHour) * 3600);
    const applied = st.remainingSec - before;
    emit(applied);
    return Math.round(applied);
  }

  /**
   * The night path of `addMoney`: integrate the donation across the priced
   * blocks, forward from the FRONTIER.
   *
   * Deficit-first falls out of that with no special case: the frontier is where funded time ends, so a cold night's money
   * buys forward from there and the gap rolls up THROUGH zero on its way to
   * positive. Everything behind the ember stays ash — territory only grows
   * ahead, the debt settles on the clock.
   *
   * Returns the GROSS seconds bought, never the net movement of the clock:
   * receipts are gross and fixed at purchase, the clock nets in public. On a
   * cold night those differ by exactly the deficit, and netting
   * here would put "+52 min" on the card for an hour someone paid for.
   *
   * Money is never refused. Past the ceiling there is nothing left to
   * price, so the cents bank into `overflowCents` and wait for an encore; the 0
   * that comes back is a statement about TIME, not about the money.
   */
  function addMoneyNight(usd) {
    reanchor();
    const n = st.night;
    const r = convertCents(
      Math.round(usd * 100), conversionFrontier(), n.blocks || [], n.durationSec);
    n.overflowCents += r.overflowCents;
    const applied = Math.round(r.seconds);
    st.remainingSec = clampRemaining(st.remainingSec + r.seconds);
    emit(applied);
    return applied;
  }

  /**
   * What `takeHome` WOULD buy, as a pure query and with no state change: the
   * badge duration and the credit-rotation weight. Every minute-denominated
   * quantity passes through the same curve, so this walks the blocks rather
   * than re-deriving anything from a rate.
   *
   * Past the ceiling the walk has nothing left to price, so the leftover cents
   * are valued at the FINAL block's rate — which is exactly what an encore
   * would grant for them (`extendBlocks` prices flat at that rate). A
   * donation's badge therefore does not change length depending on whether the
   * night is later extended.
   *
   * With no night this is the legacy flat conversion, so callers do not need to
   * know which world they are in.
   *
   * An ACTIVE night with nothing sellable (a seed covering the whole clock)
   * quotes ZERO, and does not fall through to the flat rate. That night honors
   * no rate: `addMoney` banks every cent of it to overflow and grants 0 seconds.
   * A badge or a rotation weight minted from the legacy rate there would promise
   * time the clock will never hand over; the quote and the clock have to be the
   * same answer.
   */
  function convertNotional(takeHomeUsd) {
    const usd = Number(takeHomeUsd) || 0;
    if (usd <= 0) return 0;
    if (!st.night.active) {
      return st.usdPerHour > 0 ? Math.round((usd / st.usdPerHour) * 3600) : 0;
    }
    const blocks = st.night.blocks;
    if (!blocks || !blocks.length) return 0;
    const r = convertCents(
      Math.round(usd * 100), conversionFrontier(), blocks, st.night.durationSec);
    const last = blocks[blocks.length - 1];
    const finalRate = last.cents / last.lenSec; // cents per second
    const encore = finalRate > 0 ? Math.round(r.overflowCents / finalRate) : 0;
    return Math.round(r.seconds) + encore;
  }

  // !reset: back to base, paused.
  //
  // The legacy branch deliberately does NOT clamp, and that predates the
  // night: `!reset` to a base above the cap is a mod's explicit override, so
  // this is the one mutation the ceiling does not bound. During a night it must
  // be bounded — a frontier past `durationSec` is territory nobody bought, and
  // night-math refuses to price it — and it must re-anchor FIRST, or every
  // streamed second since the last anchor is dropped from the ember.
  function reset() {
    if (st.night.active) {
      reanchor();
      st.remainingSec = clampRemaining(st.baseSec);
    } else {
      st.remainingSec = st.baseSec;
    }
    st.running = false;
    st.runningSinceMs = null;
    st.updatedAt = Date.now();
    emit();
  }
  // !cap / !hr / !fill. `cap` accepts 'on' | 'off' | a duration string (e.g. '8h').
  function setConfig({ cap, hr, fill, baseSec, lockAtZero, lowPulseEnabled,
                       lowThresholdSec, lowRampRate, lowGlowMax } = {}) {
    const refused = [];
    reanchor(); // bank remaining before a cap change can re-clamp it
    if (typeof cap === 'string') {
      const c = cap.trim().toLowerCase();
      if (c === 'off') st.capEnabled = false;
      else if (c === 'on') st.capEnabled = true;
      // A cap duration requires an explicit unit. parseDuration reads a bare
      // number as seconds (right for !a/!s), but a bare "10" in the cap field
      // means hours to whoever typed it, and a ten-second cap would clamp every
      // donation's added time. Ambiguous input on the value that bounds all
      // money→time is refused, not guessed at.
      else if (/^\d+$/.test(c)) refused.push('cap');
      else { const secs = parseDuration(c); if (secs > 0) { st.capSec = secs; st.capEnabled = true; } }
    }
    if (Number.isFinite(hr) && hr > 0) st.usdPerHour = hr;
    if (Number.isFinite(fill) && fill > 0) st.fillUsd = fill;
    if (Number.isFinite(baseSec) && baseSec > 0) st.baseSec = Math.round(baseSec);
    if (typeof lockAtZero === 'boolean') st.lockAtZero = lockAtZero;
    if (typeof lowPulseEnabled === 'boolean') st.lowPulseEnabled = lowPulseEnabled;
    // Ranges are enforced HERE, not in the web panel — the server stays the
    // single authority so a hand-rolled API call can't poison the frame.
    if (Number.isFinite(lowThresholdSec) && lowThresholdSec >= 30 && lowThresholdSec <= 7200) {
      st.lowThresholdSec = Math.round(lowThresholdSec);
    }
    if (Number.isFinite(lowRampRate) && lowRampRate > 0 && lowRampRate <= 5) {
      st.lowRampRate = lowRampRate;
    }
    if (Number.isFinite(lowGlowMax) && lowGlowMax >= 0 && lowGlowMax <= 1) {
      st.lowGlowMax = lowGlowMax;
    }
    st.remainingSec = clampRemaining(st.remainingSec); // enabling/lowering the cap can shorten it
    emit();
    // `refused` rides only when non-empty so the shape every existing consumer
    // reads is unchanged; money.js turns it into a 400 the panel can show.
    return refused.length ? { ...config(), refused } : config();
  }

  // ── Fund the Night: the lifecycle ─────────────────────────────────────────

  /**
   * Open a night: convert the streamer's bedtime to a duration, price it, tile it into
   * blocks, and open the gap at the seed.
   *
   * EVERY field of `st.night` is written here, and two of them are written
   * because they SURVIVE a night's end by design and would otherwise be
   * inherited: `elapsedSec` (frozen, never zeroed, so a dead night keeps its own
   * record of how long it ran) and `overflowCents` (an encore fund that is
   * night-scoped — last night's money may not silently buy tonight's hours).
   * The deficit dies with the night, and so does everything that measured it.
   *
   * One more thing must be cleared and it does not live in `st.night` at all:
   * `lockAtZero` does not apply to a night, and a stored `true` would
   * refuse the very donation that pays off a deficit — money-silent, on the
   * event the whole system exists to celebrate.
   *
   * `capEnabled`/`capSec` are left exactly as they were: they are inert while a
   * night is active (`clampRemaining`'s night branch bounds by the night, not
   * the cap) and `endNight` hands the clock back to them untouched.
   *
   * @param {object} o
   * @param {string} o.endLocal "4am" | "4:30am" | "04:30" | "+8h"
   * @param {string} [o.tz] IANA zone; the system zone when omitted. The env
   *   (`TIMER_TZ`) is the CALLER's business — this takes the value, not the env,
   *   which is what makes the duration math testable.
   * @param {number} [o.requiredCentsPerDay] today's ask from the meter; the
   *   price is the larger of it and the $24/h floor over the WHOLE clock
   * @param {number} [o.seedSec] free pre-funded territory at the top of the night
   * @param {number} [o.priceCents] explicit override of the computed price
   * @param {number} [o.now] injected wall clock (ms), for the end-time math and
   *   `startedAt`. The live ANCHOR always takes the real `Date.now()`, so an
   *   injected past `now` cannot retroactively age the night.
   * @returns {object} the timerState snapshot
   * @throws {NightConfigError} on an end time it cannot read
   */
  function startNight({ endLocal, tz, requiredCentsPerDay = 0, seedSec, priceCents,
                        now = Date.now() } = {}) {
    const durationSec = nightDurationSec(endLocal, tz, now); // throws before anything moves
    // `seedSec == null` and `''` explicitly, not `num()`: a JSON `null` and an
    // empty form field both reach Number() as 0, which is finite, so an omitted
    // seed would silently become "no free hours" rather than the default.
    //
    // The default is a constant, not `st.night.seedSec`. That field is the
    // per-night seed and it persists, so using it as the fallback would make
    // one explicit `seedSec: 0` the standing default for every later night. A
    // night's seed is a property of that night; the default is a property of
    // the design.
    const asked = seedSec == null || seedSec === '' || !Number.isFinite(Number(seedSec))
      ? NIGHT_SEED_DEFAULT_SEC : Number(seedSec);
    // A seed longer than the night would put the frontier past its own end.
    // Clamped rather than refused: it just means nothing is sellable tonight.
    const seed = Math.min(Math.max(0, Math.round(asked)), durationSec);
    const price = Number.isFinite(Number(priceCents)) && Number(priceCents) > 0
      ? Math.round(Number(priceCents))
      : nightPriceCents(durationSec, requiredCentsPerDay);

    Object.assign(st.night, {
      active: true,
      durationSec,
      elapsedSec: 0,
      seedSec: seed,
      priceCents: price,
      blocks: layoutBlocks(durationSec, seed, price),
      overflowCents: 0,
      startedAt: new Date(now),
    });
    st.remainingSec = seed;   // the gap opens at the seed: frontier = seedSec
    st.lockAtZero = false;
    st.updatedAt = Date.now(); // a fresh anchor; `running` follows the scene, as ever
    emit();
    return snapshot();
  }

  /**
   * The encore: `addHours` more night, priced FLAT at the final real block's
   * rate, with the overflow fund spent into it oldest-first.
   *
   * `durationSec` widens BEFORE the drain, and the order is a contract, not a
   * style: night-math throws when `blocks` outrun `durationSec`, because the
   * walk would otherwise stop at the stale end and hand the entire fund back as
   * overflow — money for nothing, silently. night-math's guard turns that into
   * a crash instead; this ordering is what keeps it from being reached.
   *
   * "Oldest first" needs no sorting: there is ONE bank, and `drainOverflow`
   * walks the blocks in order from the frontier, so the earliest unsold second
   * is always the next one bought.
   */
  function extendNight(addHours) {
    if (!st.night.active) return snapshot();
    const addSec = Math.round(Number(addHours) * 3600);
    if (!Number.isFinite(addSec) || addSec <= 0) return snapshot();
    const n = st.night;
    if (!n.blocks || !n.blocks.length) {
      // A night whose seed covered its whole clock has no rate to price an
      // encore from. Widening it anyway would add territory no donation can
      // buy, so this is refused whole rather than applied by halves.
      throw new NightConfigError(
        'extendNight: this night has no priced blocks to extend from', 'NO_BLOCKS');
    }

    reanchor();
    n.blocks = extendBlocks(n.blocks, addSec);
    n.durationSec += addSec;

    let drained = 0;
    if (n.overflowCents > 0) {
      const r = drainOverflow(n.overflowCents, conversionFrontier(), n.blocks, n.durationSec);
      drained = r.seconds;
      // `r.overflowCents` is what did NOT convert, not what was spent. Adding
      // it back would double the fund on every extension.
      n.overflowCents = r.overflowCents;
      st.remainingSec = clampRemaining(st.remainingSec + drained);
    }
    emit(Math.round(drained)); // a real deltaSec: the overlay pops the encore surge
    return snapshot();
  }

  /**
   * Re-price a RUNNING night: when the meter's required-$/day is wrong, the
   * night's target income is settable directly, mid-flight. The whole current duration — encore blocks
   * included — is re-laid with the standard curve at the new price, which is
   * the ask: same U shape, different total. (An encore's flat pricing is
   * deliberately NOT preserved through a reprice; a later `extendNight` prices
   * from the new final block, as ever.)
   *
   * What is conserved: the FRONTIER. It is a position in TIME, and money moves
   * it, so funded territory stays funded — a reprice never claws back seconds
   * someone was already granted (receipts are fixed at purchase). The flip side is equally deliberate: cents already
   * converted at the OLD rates are not re-credited. Only money arriving after
   * the reprice buys at the new rates.
   *
   * A gold night reprices inertly — the frontier is at the end, there is
   * nothing left to buy, and `overflowCents` stays banked untouched.
   *
   * `reanchor()` first, mirroring extendNight: the blocks are about to change
   * under the clock, so the streamed seconds are banked before they do.
   *
   * @param {number} priceCents the night's new WHOLE price, integer cents.
   *   An explicit target, like startNight's `priceCents` override — the
   *   $24/h floor is not re-imposed on it.
   * @returns {object} the timerState snapshot
   * @throws {NightConfigError} NO_NIGHT with no active night; BAD_TARGET on a
   *   non-positive or unreadable price
   */
  function repriceNight(priceCents) {
    if (!st.night.active) {
      throw new NightConfigError(
        'repriceNight: no night is running — the target prices a night, start one first', 'NO_NIGHT');
    }
    const price = Math.round(Number(priceCents));
    if (!Number.isFinite(price) || price <= 0) {
      throw new NightConfigError(
        'repriceNight: target must be a positive dollar amount', 'BAD_TARGET');
    }
    reanchor();
    const n = st.night;
    n.priceCents = price;
    n.blocks = layoutBlocks(n.durationSec, n.seedSec, price);
    emit(); // deltaSec 0: no time moved, the frame just re-states the night
    return snapshot();
  }

  /**
   * End the night. `reanchor()` first, so the final streamed seconds are banked
   * into the ember — it survives deactivation by design (a dead night keeps its
   * own record), and the read has to happen before `active` goes false.
   *
   * The deficit dies here: it never carries into the next stream's clock. `wireRemaining()` and the persisted row already floor a negative gap
   * the instant `active` is false, so the in-memory number is squared with them
   * rather than left for the next mutation to floor — one state, not two.
   *
   * The handoff is clamped at both ends, because the night's bounds are not
   * the marathon's. A long night gone gold can hand back more than the cap;
   * left raw, the legacy clamp bites on the next donation instead
   * (`applied = clamp(gap + added) − gap` goes negative) and a tip broadcasts a
   * negative deltaSec at the person who sent it. A mod who wants to carry time
   * forward uses `/timer set`, an explicit act. The legacy config (cap, rate,
   * base) resumes untouched; `lockAtZero` stays cleared.
   *
   * With no night active this is a no-op. Run with no night to end, the clamp
   * would re-clamp a legacy clock that is deliberately allowed to sit above the
   * cap (`!reset` to a base above it is a mod's explicit override), so a
   * double-tapped "End night" or a retried request would quietly eat that
   * override.
   */
  function endNight() {
    if (!st.night.active) return snapshot();
    reanchor();
    st.night.active = false;
    // `active` is already false, so `clampRemaining` takes its legacy branch
    // (floor 0, ceiling `capSec`). The inner `Math.max(0, …)` is redundant and
    // kept deliberately, so "the deficit dies with the night" is legible at the
    // line where the night dies.
    st.remainingSec = clampRemaining(Math.max(0, st.remainingSec));
    emit();
    return snapshot();
  }

  // ── Fund the Night: liveness pause (night-liveness.js) ────────────────────

  /**
   * Pause the night's clock as if the pause had happened back at `sinceMs` —
   * the retroactive half of night-liveness.js's outage handling. Every second
   * between `sinceMs` and now was already counted as elapsed, so this claws
   * that stretch back out of the ember and hands it to the gap. The same amount
   * moves in each direction, so the frontier (`elapsed + gap`, what money has
   * funded) never moves: only a donation may move it, never an outage.
   *
   * - `reanchor()` first, so the correction lands on the same numbers a plain
   *   pause would.
   * - One clipped refund is applied to both accumulators. `elapsedSec` cannot go
   *   negative, so the refund is bounded by it, identically on both sides, which
   *   keeps `elapsed + gap` constant.
   * - `st.running = false` is set before `clampRemaining`, so the floor and
   *   ceiling read the settled `elapsedSec`, not one still ticking.
   * - With no night this is an ordinary `control('pause')`.
   * - A night that is already paused is a no-op. The caller acts after an
   *   awaited DB read and the clock may be paused by something else meanwhile;
   *   a frozen clock accrued nothing, and `now − sinceMs` would otherwise keep
   *   growing into a fabricated refund.
   * - The refund is bounded by the time the clock actually ran since `sinceMs`
   *   (`runningSinceMs`), not by wall time. They differ when something resumed
   *   the clock mid-outage: `lastLiveMs` cannot move while the stream is down,
   *   so the next outage decision hands over the same anchor, and a wall-time
   *   bound would pay it twice. With `runningSinceMs` unset (only reachable from
   *   a test that sets `running` directly) it falls back to the wall-time bound,
   *   so an unknown stretch never stops refunding real outages.
   *
   * @param {number} sinceMs the last moment the stream was provably live
   *   (night-liveness.js's `lastLiveMs`, floored at that module's own last
   *   pause, or its debounce-start time when no better anchor exists)
   * @returns {object} the timerState snapshot, like every sibling mutator
   */
  function pauseRetroactive(sinceMs) {
    if (!st.night.active) { control('pause'); return snapshot(); }
    if (!st.running) return snapshot(); // already frozen — nothing accrued, nothing to refund
    reanchor();
    const now = Date.now();
    const dt = Math.max(0, (now - sinceMs) / 1000); // clamp: a future/bad anchor refunds nothing, never negative
    // The clock can only give back what it actually counted: the running
    // stretch since `sinceMs` is `now − max(sinceMs, runningSinceMs)`.
    const ranSec = st.runningSinceMs == null
      ? dt
      : Math.max(0, (now - Math.max(sinceMs, st.runningSinceMs)) / 1000);
    // never more than the outage, never more than the clock ran, never more
    // than the ember holds
    const refund = Math.min(dt, ranSec, st.night.elapsedSec);
    st.night.elapsedSec = Math.max(0, st.night.elapsedSec - refund); // belt: refund <= elapsedSec already guarantees >= 0
    st.running = false;
    st.runningSinceMs = null;
    st.remainingSec = clampRemaining(st.remainingSec + refund);
    emit();
    return snapshot();
  }

  // Auto pause on the pause scene (a break / outro scene), play otherwise.
  function applyScene(sceneName) {
    const pause = pauseScene();
    if (!pause) return;
    control(sceneName === pause ? 'pause' : 'play');
  }
  function wireScenePause() {
    if (!obs) return;
    obs.onSceneChange((scene) => applyScene(scene));
    const trySync = async () => {
      const scene = await obs.getCurrentScene();
      if (scene) applyScene(scene);
      else setTimeout(trySync, 5000);
    };
    setTimeout(trySync, 2000);
  }

  // Heartbeat: change-aware re-broadcast + persist (see heartbeatTick above).
  function startHeartbeat(ms = 15000) {
    const t = setInterval(heartbeatTick, ms);
    if (t.unref) t.unref();
    return t;
  }

  // ── Room lights on a low timer ──────────────────────────────
  //
  // Red flashes while the marathon is inside its low window, speeding up as it
  // counts down — the room mirroring the accelerating pulse the site and the OBS
  // overlay already show. At zero the lights go OUT.
  //
  // Built entirely on lights.flash(). flash() already serializes against
  // alerts, drops rather than queues when one is in flight, and restores the
  // previous state in a `finally`, which is what stops a crash mid-window from
  // leaving the room red. A separate "hold red" state would give that up.
  //
  // Cadence is floored at LOW_FAST_MS: it is a room someone sits in for hours,
  // not a klaxon.
  //
  // The ramp is keyed to absolute time, not to a fraction of the threshold.
  // Interpolating over the mod-configurable `lowThresholdSec` would make the
  // last minute's intensity depend on that number; "frantic by the last minute"
  // is a statement about the clock, so it is measured against the clock.
  const LOW_CALM_SEC = 300;      // 5 min — the slow end
  const LOW_FRANTIC_SEC = 60;    // 1 min — full panic, and everything below it
  const LOW_SLOW_MS = 45_000;    // cadence at 5 min
  const LOW_FAST_MS = 2_500;     // cadence in the last minute — the floor
  // Urgency is mostly delivered by the cadence, not by stacking pulses into
  // each burst. Each extra pulse costs two more commands per bulb, and smart
  // bulbs' latency degrades sharply under back-to-back traffic, so a
  // burst-heavy ending congests the mesh and drops bulbs to `unavailable`.
  const LOW_PULSES_CALM = 1, LOW_PULSES_FRANTIC = 2;
  const LOW_HOLD_CALM = 700, LOW_HOLD_FRANTIC = 220;
  const LOW_RED = [255, 30, 30];
  let lastLowFlash = 0;
  let firedZeroOff = false;
  // Has this clock been seen above zero? The blackout is a transition — "the
  // marathon just ran out" — not a state. A restart while the timer sits at 0
  // from the previous stream must not turn the room's lights off.
  let sawPositive = false;

  /** 0 at five minutes and above, 1 at one minute and below. */
  function lowIntensity(remaining) {
    if (!(remaining > 0)) return 1;
    if (remaining >= LOW_CALM_SEC) return 0;
    if (remaining <= LOW_FRANTIC_SEC) return 1;
    return (LOW_CALM_SEC - remaining) / (LOW_CALM_SEC - LOW_FRANTIC_SEC);
  }

  /**
   * The whole shape of the warning at a given remaining time: how often it
   * fires, how many pulses, and how long each one holds.
   *
   * The hold SHRINKS as the cadence tightens, and it has to. A flash that
   * outlasts its own cadence is dropped by lights.flash()'s in-flight guard, so
   * a ramp that only sped up the cadence would make the room go QUIETER exactly
   * as the marathon got most urgent. timerLights.test.js pins that invariant
   * across the whole ramp.
   */
  function lowShape(remaining) {
    const k = lowIntensity(remaining);
    const lerp = (a, b) => a + (b - a) * k;
    return {
      cadenceMs: Math.round(lerp(LOW_SLOW_MS, LOW_FAST_MS)),
      pulses: Math.round(lerp(LOW_PULSES_CALM, LOW_PULSES_FRANTIC)),
      holdMs: Math.round(lerp(LOW_HOLD_CALM, LOW_HOLD_FRANTIC)),
    };
  }

  /** Exposed for tests: the flash gap at a given remaining time. */
  function lowCadenceMs(remaining) { return lowShape(remaining).cadenceMs; }

  function lowLightsTick(now = Date.now()) {
    if (!lights || !lights.enabled()) return;
    // The raw gap, deliberately. Every decision below turns on `> 0` or `<= 0`,
    // and a night's negative gap answers those the same way a clamped 0 would:
    // the blackout is the zero crossing, and a cold night has already crossed.
    const remaining = liveGap();

    // Back above zero → re-arm, so a marathon revived by a donation can go dark
    // again if it runs out a second time. Also the only place `sawPositive` is
    // set: the blackout needs to have watched the clock RUN OUT, not merely
    // found it at zero.
    if (remaining > 0) { firedZeroOff = false; sawPositive = true; }

    // Zero fires EVEN IF the low effects are switched off or the clock is
    // paused. `low_pulse_enabled` governs the warning treatment; the room going
    // dark at zero is the ending, not a warning about one. Guarded by
    // firedZeroOff so it is one call, not one every tick forever.
    //
    // During a night this fires mid-stream, by design: the marathon meaning is
    // "it is over", the night's is "the fire went out — still live, now unpaid",
    // and the room mirrors that. The re-arm above relights on revival, so a
    // donation that pays off the deficit takes the room back with it.
    if (remaining <= 0) {
      if (!firedZeroOff) {
        firedZeroOff = true;
        lastLowFlash = 0;
        // Only on a clock watched running out. Finding it already at zero (the
        // state after every finished marathon, so at every restart) arms the
        // guard silently.
        if (sawPositive) {
          Promise.resolve(lights.off()).catch((e) => console.warn('[timer] lights off:', e.message));
        }
      }
      return;
    }

    // Warning flashes, unlike the blackout, only run on a RUNNING clock inside
    // the window with effects enabled — a paused timer is not counting down, so
    // flashing about it would be describing nothing.
    if (!st.running || !st.lowPulseEnabled) return;
    if (remaining > st.lowThresholdSec) return;

    const shape = lowShape(remaining);
    if (now - lastLowFlash < shape.cadenceMs) return;
    lastLowFlash = now;
    // Fire-and-forget, exactly like alert.js's use of it. A dropped flash (one
    // already running) is fine and deliberate — see flash()'s own note.
    Promise.resolve(lights.flash('timer_low', {
      rgb: LOW_RED, pulses: shape.pulses, holdMs: shape.holdMs,
    })).catch((e) => console.warn('[timer] lights:', e.message));
  }

  function startLowLights(ms = 5000) {
    const t = setInterval(() => lowLightsTick(), ms);
    if (t.unref) t.unref();
    return t;
  }

  return {
    init, adjust, set, control, addMoney, reset, setConfig, wireScenePause,
    startHeartbeat, startLowLights, snapshot, config, parseDuration,
    startNight, extendNight, endNight, repriceNight, convertNotional, pauseRetroactive,
    __test: {
      lowCadenceMs, lowShape, lowIntensity, lowLightsTick, heartbeatTick,
      LOW_SLOW_MS, LOW_FAST_MS, LOW_CALM_SEC, LOW_FRANTIC_SEC, st,
      frontierSec, conversionFrontier,
    },
  };
}

module.exports = { createTimer, parseDuration };
