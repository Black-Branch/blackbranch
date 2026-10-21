// Operator notifications — the one path by which a guard reaches a human.
//
// A sibling of obs.js and lights.js, held to the same discipline: **best-effort,
// never throwing, no-op when unreachable**. An unreachable ntfy, a mistyped
// topic or a phone in a tunnel must never be able to affect the path that raised
// the alarm. The money is already banked and the card is already on screen by the
// time we get here — a failed notification is a log line and nothing more.
//
// Why this exists: a guard that only logs (console.warn into journald) has no
// reader. A clamped negative take-home or a rejected /alert envelope needs to
// reach a person.
//
// Why ntfy: an alert channel is ranked by failure-domain distance first, build
// cost second. A channel hosted beside the services it reports on goes down with
// them — host dies, every service down AND no alert. ntfy.sh is outside every
// failure domain the platform owns.
//
// TWO TOPICS, AND SEVERITY PICKS BETWEEN THEM:
// `critical: true` → the WAKE topic at priority 5 (DND-overriding on the phone);
// everything else → the QUIET topic at priority 3. One mute switch per tier, so
// muting noise can never mute a money-path alarm.
//
// SHIPS DISABLED. With no topic URL set this module answers `enabled() === false`
// and every call returns immediately, exactly like lights.js. ONE topic is enough:
// both tiers then go to it, and the priority header still tells them apart
// (5 overrides Do Not Disturb, 3 does not). Two topics give each tier its own
// subscription and its own mute switch:
//
//   NTFY_WAKE_URL    e.g. https://ntfy.sh/<wake-topic>   (keep the topic private)
//   NTFY_QUIET_URL   e.g. https://ntfy.sh/<quiet-topic>  (keep the topic private)
//
// With none set, important problems stay visible in the Admin Panel (the doctor
// says "Alerts reach nobody"); a push is optional.
//
// NEVER PASS A PAYLOAD VALUE. A push notification renders on a lock screen, on
// a device that leaves the house — and these topics are UNAUTHENTICATED: the
// topic name is the only secret, so treat every publish as potentially public.
// Keys, event types and counts only — never a donor name, an amount, a message
// body or a token. The money-path discipline applies to what leaves the box, not
// just to what is written to the ledger.

'use strict';
const { instanceConfig } = require('./instance-config');

// Instance keys ntfy.wakeUrl / ntfy.quietUrl (env NTFY_WAKE_URL / NTFY_QUIET_URL, else the stored
// credential), read per send.
const topicUrl = (key) => String(instanceConfig.get(key) || '').trim().replace(/\/+$/, '');
// One topic set: it takes both tiers.
const wakeUrl = () => topicUrl('ntfy.wakeUrl') || topicUrl('ntfy.quietUrl');
const quietUrl = () => topicUrl('ntfy.quietUrl') || topicUrl('ntfy.wakeUrl');
// Escape hatch that does not require unsetting the topic URLs.
const ENABLED = process.env.OPS_NOTIFY_ENABLED !== '0';
const TIMEOUT_MS = Number(process.env.OPS_NOTIFY_TIMEOUT_MS || 4000);

// THE COOLDOWN IS LOAD-BEARING, not politeness.
//
// A rejected /alert fires once per malformed message; a clamped take-home could
// fire per event during a bad Kick payload shape. A notifier that floods is a
// notifier you mute, and a muted notifier is exactly the state this module was
// written to escape — worse than none, because it reads as covered.
//
// So: at most one push per key per window, and the count of what was swallowed
// rides the NEXT one. Nothing is silently dropped; it is batched.
const COOLDOWN_MS = Number(process.env.OPS_NOTIFY_COOLDOWN_MS || 15 * 60 * 1000);

// Bound the key table. Keys are meant to be a small fixed set, but a caller that
// ever interpolates a user id into one would otherwise grow this without limit in
// a process that runs for weeks.
const MAX_KEYS = 200;

/** key -> { last: epochMs, suppressed: n, first: epochMs } */
const seen = new Map();

function enabled() {
  return ENABLED && !!wakeUrl();
}

// undici refuses a non-ASCII header value, and a refused header is a LOST alert.
// The relay accepts arbitrary caller text, so this is enforced here, not assumed
// of callers. The body is UTF-8-safe and goes through untouched.
function asciiHeader(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '?');
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Decide whether this key may send right now, and what it owes from suppressed
 * predecessors. Pure apart from the clock, so the rate-limiting is testable
 * without touching the network.
 *
 * @returns {{send: boolean, suffix: string}}
 */
function gate(key, now) {
  const rec = seen.get(key);
  if (rec && now - rec.last < COOLDOWN_MS) {
    rec.suppressed += 1;
    return { send: false, suffix: '' };
  }
  // Cheapest correct eviction: drop the least recently used. The table is a
  // rate-limiter, not a record — losing an old entry costs one extra push.
  if (!rec && seen.size >= MAX_KEYS) {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of seen) if (v.last < oldest) { oldest = v.last; oldestKey = k; }
    if (oldestKey !== null) seen.delete(oldestKey);
  }
  const suppressed = rec ? rec.suppressed : 0;
  const since = rec ? rec.first : now;
  seen.set(key, { last: now, suppressed: 0, first: now });
  return {
    send: true,
    suffix: suppressed > 0 ? ` (+${suppressed} more since ${hhmm(since)})` : '',
  };
}

/**
 * Send one operator notification. Fire-and-forget.
 *
 * NEVER REJECTS. Callers are guard paths that must not care whether this
 * worked, and several of them are not awaited — a rejection there would surface
 * as an unhandledRejection and take down the very service it was reporting on.
 *
 * @param {string} key      stable dedup key, e.g. 'alert.takehome-clamped'
 * @param {string} title    short; shows as the notification title
 * @param {string} message  one line. NO payload values — see the header.
 * @param {{critical?: boolean}} [opts] critical bypasses the phone's quiet hours
 * @returns {Promise<boolean>} true if a push was actually sent
 */
function notify(key, title, message, opts = {}) {
  if (!enabled()) return Promise.resolve(false);

  const { send, suffix } = gate(String(key), Date.now());
  if (!send) return Promise.resolve(false);

  // Severity picks the TOPIC, not just a header: wake and quiet are separate
  // subscriptions on the phone, each with its own mute switch and its own
  // DND behaviour. Priority 5 is what the ntfy app lets override DND.
  const headers = opts.critical
    ? { Title: asciiHeader(title), Priority: '5', Tags: 'rotating_light' }
    : { Title: asciiHeader(title), Priority: '3' };

  return fetch(opts.critical ? wakeUrl() : quietUrl(), {
    method: 'POST',
    headers,
    body: `${message}${suffix}`,
    // A publish that is accepted and then never answered must not hold a
    // handle open for the process lifetime.
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(
    (res) => {
      if (!res.ok) {
        console.warn('[notify] ntfy %s for key=%s', res.status, key);
        return false;
      }
      return true;
    },
    (e) => {
      // The one place this module is allowed to be noisy about itself. If ntfy
      // is unreachable we say so once per key per window, courtesy of the same
      // gate above.
      console.warn('[notify] %s (key=%s)', e.message, key);
      return false;
    },
  );
}

/** Test seam: forget all rate-limiter state. */
function _resetNotifyState() {
  seen.clear();
}

// ── The relay for the OTHER process ──────────────────────────────────────────
//
// stream-ingest has no notifier of its own; without this relay it has no way to
// reach a human at all, and an outage there sits behind a console.warn. It is
// deliberately not given its own token and its own copy of this module:
//
//   • ONE rate limiter. Two independent cooldowns cannot batch each other's
//     bursts, and the cooldown here is load-bearing rather than polite. Two
//     notifiers is two things to mute, and a half-muted channel reads as covered.
//   • ONE config. A second copy of the topic URLs is a second thing to rotate
//     when a topic name leaks, and a second place to miss.
//
// WHAT THIS COSTS, stated plainly: if stream-api is down, stream-ingest cannot
// notify. That is deliberate and already covered — a dead SERVICE stops feeding
// its `deadman:` push monitor (a heartbeat script on the host) and Uptime Kuma
// alerts on the silence, because in-process code cannot report its own death.
// This path is for the other failure: a process that is alive and healthy-
// looking while its writes all fail.
//
// THIS IS A RELAY, NOT A MEGAPHONE. The no-payload-values rule in the header
// applies to whatever arrives here, and a remote caller cannot be trusted to have
// read it. So the shape is constrained rather than merely documented: the key must
// look like a key, and title/message are hard-capped. A caller that tries to push
// a donor name or a token through gets a truncated string, not a lock screen.
const KEY_RE = /^[a-z0-9][a-z0-9._-]{2,59}$/;
const MAX_TITLE = 80;
const MAX_MESSAGE = 200;

function registerNotifyRoutes(app, { requireInternal, wrap }) {
  // POST /ops/notify — { key, title, message, critical? }
  // Internal-only. Answers 202 whether or not a push actually went out: the
  // caller is a guard path and must never branch on our delivery, exactly as
  // in-process callers of notify() never do.
  app.post('/ops/notify', requireInternal, wrap(async (req, res) => {
    const { key, title, message, critical } = req.body || {};
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      return res.status(400).json({ error: 'bad_key' });
    }
    if (typeof title !== 'string' || typeof message !== 'string' || !title || !message) {
      return res.status(400).json({ error: 'bad_body' });
    }
    // Not awaited into the response — same fire-and-forget contract as every
    // in-process caller. `notify` never rejects.
    notify(key, title.slice(0, MAX_TITLE), message.slice(0, MAX_MESSAGE), { critical: !!critical });
    res.status(202).json({ ok: true });
  }));
}

module.exports = {
  notify, enabled, _resetNotifyState, gate,
  registerNotifyRoutes, __test: { KEY_RE, MAX_TITLE, MAX_MESSAGE },
};
