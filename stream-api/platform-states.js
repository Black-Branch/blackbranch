// ── Per-platform liveness, relayed ──────────────────────────────────────────
// stream-ingest's poller owns each platform's state (live / offline / unknown / upcoming) and posts
// the whole set here once per tick (POST /stream/platforms). stream-api keeps the LAST body, cuts it
// to what the public may read (PLATFORM_LIVENESS.publicSnapshot: state, since, YouTube's scheduled
// start — no broadcast key, no evidence code, no counts) and hands it on two ways:
//   • /stream/current's `liveness` (lifecycle.js) — the site reads it there; no GET of its own;
//   • a `platformStates` frame on the socket, on connect and whenever the public picture changes.
//
// No sequence number: every body is a full snapshot, so the last one received wins — an ingest
// restart (its clock or counts starting over) is never ignored as "older".
//
// Silence (plan Review Focus 1): when no report has come for clamp(3 × nextInMs, 180 s, 600 s) —
// stream-ingest stopped, or cannot reach us — every platform present reads `unknown` from the
// moment the silence began. Nothing here opens or ends a session: an unknown is "cannot tell",
// and the site keeps what it shows. A 30 s timer broadcasts the flip, once.

'use strict';
const { PLATFORM_LIVENESS } = require('./platformLiveness.generated.js');

const SILENCE_MIN_MS = 180_000;
const SILENCE_MAX_MS = 600_000;
const SILENCE_CHECK_MS = 30_000;

/** How long after a report the snapshot is still believed: three of the poller's own gaps, bounded. */
function silenceAfterMs(nextInMs) {
  const n = typeof nextInMs === 'number' && Number.isFinite(nextInMs) && nextInMs > 0 ? nextInMs : 0;
  return Math.min(SILENCE_MAX_MS, Math.max(SILENCE_MIN_MS, 3 * n));
}

function createPlatformStates({ broadcast, now = Date.now }) {
  // The last report: its public platforms, when it arrived, and how long it is believed.
  let last = null; // { platforms, receivedAt, silentAt }
  let lastSent = JSON.stringify({}); // the platforms of the last broadcast frame (or the empty start)

  /** @returns {import('./platformLiveness.generated.js').PublicSnapshot} */
  function snapshot() {
    const t = now();
    if (!last) return { at: t, platforms: {} };
    if (t < last.silentAt) return { at: last.receivedAt, platforms: last.platforms };
    const platforms = {};
    for (const name of Object.keys(last.platforms)) platforms[name] = { state: PLATFORM_LIVENESS.STATES.unknown, since: last.silentAt };
    // Stamped when the silence began, not with the report's time: a page keeps the newest snapshot
    // by `at` (web livePlatforms.ts `newest`, a tie keeps what is shown), so an open page holding
    // that report would otherwise never apply the silence.
    return { at: last.silentAt, platforms };
  }

  function frame() {
    return { type: 'platformStates', ...snapshot() };
  }

  // Broadcast only when the public picture moved — a tick that changed nothing is not news.
  function maybeBroadcast() {
    const f = frame();
    const key = JSON.stringify(f.platforms);
    if (key === lastSent) return;
    lastSent = key;
    broadcast(f);
  }

  /** One report from the poller. False when the body is not one (the route answers 400). */
  function accept(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const p = body.platforms;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    const receivedAt = now();
    last = {
      platforms: PLATFORM_LIVENESS.publicSnapshot(p, receivedAt).platforms,
      receivedAt,
      silentAt: receivedAt + silenceAfterMs(body.nextInMs),
    };
    maybeBroadcast();
    return true;
  }

  // The silence flip has no request to ride on: a timer looks for it. Never holds the process open.
  const timer = setInterval(() => {
    try { maybeBroadcast(); } catch (e) { console.warn('[platform-states]', e.message); }
  }, SILENCE_CHECK_MS);
  if (timer.unref) timer.unref();

  function registerRoutes(app, { requireInternal, wrap }) {
    // POST /stream/platforms — stream-ingest's poller, once per tick: { at, nextInMs, platforms }.
    app.post('/stream/platforms', requireInternal, wrap(async (req, res) => {
      if (!accept(req.body)) return res.status(400).json({ error: 'platforms object required' });
      res.json({ ok: true });
    }));
  }

  function stop() { clearInterval(timer); }

  return { accept, snapshot, frame, registerRoutes, stop };
}

module.exports = { createPlatformStates };
