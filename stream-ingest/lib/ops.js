// Operator notifications from stream-ingest — the one path by which a guard in
// THIS process reaches a human.
//
// WHY IT IS A RELAY AND NOT A NOTIFIER. stream-api holds the notification
// credential and already owns the rate limiter, the dedup keys and the "never
// throws" contract (stream-api/notify.js). A second copy here would mean a second
// credential to rotate and a second cooldown that cannot batch the first one's
// bursts — and a half-muted alert channel reads as covered while being worse than
// none. One notifier, one place to mute.
//
// WHY IT EXISTS. A failure counter or a console.warn that nothing reads is a silent
// failure: this module is how a guard in this process reaches a human.
//
// WHAT IT CANNOT DO: if stream-api is down, this cannot notify. That is the correct
// division. A dead service is caught from outside (a heartbeat monitor alerting on
// silence) — in-process code structurally cannot report that it stopped running.
// This path covers the other failure — a process that is alive, healthy-looking
// and getting nothing done.
//
// NEVER PASS A PAYLOAD VALUE. These render on a phone's lock screen. Keys, counts
// and error CLASSES only — never a username, a message body, an amount or a token.
// stream-api caps and validates what arrives, but a cap is a backstop, not
// permission.

import { streamApiBase } from './streamApiUrl.js';

const SECRET = process.env.STREAM_API_SECRET || '';
// Escape hatch that matches stream-api's own, so ops can silence both ends.
const ENABLED = process.env.OPS_NOTIFY_ENABLED !== '0';

/**
 * Send one operator notification. Fire-and-forget.
 *
 * NEVER REJECTS, and never awaits anything the caller needs. Every call site is
 * a guard on a failure path; a rejection here would surface as an
 * unhandledRejection and take down the process it was reporting on — the precise
 * shape of bug this whole module exists to make visible.
 *
 * @param {string} key      stable dedup key, e.g. 'ingest.impressions-failing'
 * @param {string} title    short
 * @param {string} message  one line, no payload values
 * @param {{critical?: boolean}} [opts]
 * @returns {Promise<boolean>} true only if stream-api accepted the relay
 */
export function notifyOps(key, title, message, opts = {}) {
  if (!ENABLED) return Promise.resolve(false);
  let base;
  try { base = streamApiBase(); } catch (e) {
    // Never rejects (see above) — but never silent either.
    console.error('[ops] notify dropped: %s (key=%s)', e.message, key);
    return Promise.resolve(false);
  }
  return fetch(`${base}/ops/notify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {}),
    },
    body: JSON.stringify({ key, title, message, critical: !!opts.critical }),
    // stream-api under load can accept a socket and never answer. Without a
    // deadline this holds a handle for the process lifetime — in a process that
    // runs for weeks.
    signal: AbortSignal.timeout(5000),
  }).then(
    (res) => res.ok,
    (e) => {
      // The one place this module may be noisy about itself. No retry: a
      // notification that arrives late is worth less than the risk of a retry
      // loop on the failure path it is reporting.
      console.warn('[ops] notify relay failed: %s (key=%s)', e.message, key);
      return false;
    },
  );
}

/**
 * A consecutive-failure alarm for a fire-and-forget path.
 *
 * THE RUN IS THE SIGNAL, NOT THE FAILURE. Every path this wraps is one where a
 * single failure is an ordinary blip — a network hiccup, one bad payload — and
 * where a RUN means the thing is simply not working. Alarming on the first
 * failure produces a channel that cries wolf, and a channel that cries wolf gets
 * muted, taking the real alarm with it. Alarming on none leaves an outage silent.
 *
 * `ok()` MUST be called on the success path. Without it an intermittent fault
 * creeps to the threshold over days and reports a healthy writer as broken —
 * the cry-wolf failure by a slower route.
 *
 * @param {{key: string, title: string, after?: number}} spec
 */
export function makeRunAlarm({ key, title, after = 5 }) {
  let consecutive = 0;
  let lastOkAt = 0;
  return {
    /**
     * Record a failure. `detail` must contain NO payload values — it rides to a
     * lock screen. Counts, durations and error CLASSES only.
     */
    fail(detail = '') {
      consecutive += 1;
      if (consecutive < after) return;
      const since = lastOkAt
        ? `last success ${Math.round((Date.now() - lastOkAt) / 60000)}m ago`
        : 'no success since boot';
      notifyOps(key, title, `${consecutive} consecutive — ${since}${detail ? ` — ${detail}` : ''}`);
    },
    ok() {
      consecutive = 0;
      lastOkAt = Date.now();
    },
    /** Test seam and health read. */
    state() {
      return { consecutive, lastOkAt };
    },
    _reset() {
      consecutive = 0;
      lastOkAt = 0;
    },
  };
}
