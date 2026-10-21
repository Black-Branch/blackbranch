// Support-bar dollar total for the unified alert system (stream-api).
//
// Holds the cumulative
// take-home (USD) for the current stream in memory, broadcasts `updateSupportBar`
// (consumed by support-bar.html) on every contribution, and recomputes from
// stream.support_events on startup so a restart mid-stream doesn't lose the bar.
//
// Time is not this module's concern: money→time lives in the timer (timer.js,
// the authority). `earnTime(takeHome) → secondsAdded` is injected by
// index.js and forwarded so alert cards can still show the per-event "+time".
// The bar's segment size / fill target come from the timer's `timerState` frame.

'use strict';
const { round2 } = require('./economics');
const { NATIVE_SQL } = require('./native-platform');

// Factory: index.js injects `pool` + `broadcast` + `getStreamId` (async → the
// active stream_id or null) + `earnTime` (async/sync → seconds this $ actually
// added to the timer) + optional `onAdd` (fired after earnTime resolves, with
// a payload — e.g. the "how fucked am I" meter's notifyMoney and the
// Fund-the-Night sponsors pool; exceptions swallowed so a hook never breaks a
// real contribution) + optional `notionalFor` (sync $ → NOTIONAL seconds, via
// timer.convertNotional — what the donation is WORTH on the night's curve,
// which is not always the same as `grossSec`: a capped or locked timer
// credits fewer actual seconds than the curve would have priced, and the
// credit-line/badge math wants the curve's answer, not the clamped one; it is
// called and used synchronously — never awaited — so a Promise return would
// silently fail the finite check below and fall back to grossSec). Keeps this
// module DB/transport-agnostic + testable.
function createSupportBar({ pool, broadcast, getStreamId, earnTime, onAdd, notionalFor, excludeEventTypes = [] }) {
  let total = 0;

  // Recompute the running total from logged support events for the active
  // stream. `excludeEventTypes` (index.js: money's COIN_KINDS) keeps currency
  // spends out — their historical rows are spectacle, not support.
  async function init() {
    try {
      const streamId = await getStreamId();
      if (!streamId) { total = 0; return total; }
      // event_type is nullable (schema.sql) and a blank kind lands as NULL
      // (money.js stores `eventType || null`) — `NULL <> ALL(...)` is NULL,
      // and WHERE drops that row. An untyped row is not a currency spend, so
      // COALESCE keeps it counted rather than silently losing it.
      //
      // The exclusion is platform-scoped: `excludeEventTypes` (COIN_KINDS) is
      // a list of event_type strings ('cheer', 'sticker', …), and a currency spend
      // is the ONLY producer of them — but nothing in the schema stops an
      // external platform from someday sending `event_type='cheer'`
      // (stream-ingest/lib/alerts.js already emits `bits`/'cheered' for
      // Twitch) or `'sticker'`. Naming the site's own platform too means a
      // same-named row from an external source is still real support and
      // stays counted — only the site's own coin-spend rows are excluded.
      //
      // A credit whose refunds were held before it landed counts only what the live bar admitted
      // of it (admitted_usd, v159); NULL is the row's own amount.
      const r = await pool.query(
        `SELECT COALESCE(SUM(COALESCE(admitted_usd, amount_usd)), 0) AS s FROM stream.support_events
          WHERE stream_id = $1 AND NOT (platform IN ${NATIVE_SQL} AND COALESCE(event_type, '') = ANY($2::text[]))`,
        [streamId, excludeEventTypes]
      );
      total = round2(Number(r.rows[0]?.s || 0));
      console.log(`[supportbar] init total $${total.toFixed(2)} (stream ${streamId})`);
    } catch (e) {
      console.warn('[supportbar] init failed:', e.message);
      total = 0;
    }
    return total;
  }

  // Add a take-home contribution: bump the $ total + broadcast, and forward the $
  // to the timer for its time credit. Returns the new total and the seconds the
  // timer added (surfaced on the alert card). `takeHome` <= 0 is a no-op.
  //
  // ORDER IS THE INVARIANT timer-lock-policy.test.js pins: bank the total and
  // broadcast `updateSupportBar` BEFORE calling earnTime. A locked/capped timer
  // refuses TIME, never MONEY (see timer.js's addMoney), and that refusal must
  // never be able to cost the donation upstream of the bank. `onAdd` runs AFTER
  // earnTime because it needs earnTime's answer for its payload; that is safe
  // only because onAdd is downstream of the bank, and it must never move ahead.
  // `userId` is the canonical stream.users id `recordSupport` resolved before
  // the ledger write (alert.js / money.js pass it); it rides
  // the onAdd payload so the sponsor pool keys live money the way its restart
  // replay does, and can name the donor by their site account. Optional.
  // `ledgerId` (optional): the support_events row id, passed on to the sponsor pool (sponsors.js).
  function add(takeHome, username, userId = null, ledgerId = null) {
    const delta = round2(Number(takeHome) || 0);
    if (delta <= 0) return { total, deltaSeconds: 0 };
    total = round2(total + delta);
    broadcast({
      type: 'updateSupportBar',
      username: username || '',
      total,   // number (overlay parseFloat)
      delta,
    });
    // Guarded like the read-only quote below, and for the same reason:
    // timer.addMoney can THROW on a corrupt night frontier (night-math's
    // convertCents guard). The bank moved and the frame went out above — a
    // throw escaping here 500s the money route AFTER the fact, and Ko-fi /
    // Streamlabs retry a 500, so the same dollars land twice. Time degrades to 0; the ledger, the bar, the card stand.
    let deltaSeconds = 0;
    try { deltaSeconds = (earnTime ? earnTime(delta) : 0) || 0; }
    catch (e) { console.warn('[supportbar] earnTime:', e.message); }
    if (onAdd) {
      // `notionalSec` defaults to the timer's actual grossSec and is upgraded
      // when `notionalFor` is injected and returns a usable number.
      // `timer.convertNotional` can THROW on a corrupt night frontier — caught
      // here, independently of onAdd's own guard below, so a bad quote
      // degrades to the gross seconds rather than losing the payload. Coerced
      // on the non-throwing path too: NaN/undefined/Infinity must not ride
      // onto the payload.
      //
      // Floored at grossSec, not just replaced by the quote. `notionalFor` runs
      // AFTER `earnTime`, a real mutating credit that has already moved the
      // frontier by this donation's purchase, so on a ramping curve the quote
      // prices later, dearer territory and under-values an ordinary donation;
      // `grossSec` is the true notional there. For a donation entirely past
      // gold, `earnTime` grants 0 and leaves the frontier alone, so the quote
      // is exact. Only the one donation per night that straddles gold is
      // under-counted (by its overflow tail), which is accepted.
      let notionalSec = deltaSeconds;
      if (notionalFor) {
        try {
          const quoted = notionalFor(delta);
          const safeQuoted = Number.isFinite(quoted) ? quoted : deltaSeconds;
          const safeGross = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
          notionalSec = Math.max(safeGross, safeQuoted);
        } catch (e) { console.warn('[supportbar] notionalFor:', e.message); notionalSec = deltaSeconds; }
      }
      try {
        onAdd({
          username: username || '',
          userId: userId != null && userId !== '' ? String(userId) : null,
          cents: Math.round(delta * 100), grossSec: deltaSeconds, notionalSec,
          ledgerId: ledgerId != null && ledgerId !== '' ? String(ledgerId) : null,
        });
      } catch (e) { console.warn('[supportbar] onAdd:', e.message); }
    }
    return { total, deltaSeconds };
  }

  function reset() {
    total = 0;
    broadcast({ type: 'resetSupportBar' });
    console.log('[supportbar] reset');
  }

  return { init, add, reset, getTotal: () => total };
}

module.exports = { createSupportBar };
