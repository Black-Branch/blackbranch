'use strict';
// Banned chatters, at the chat door.
//
// Without this module, a mod banning a platform chatter on the site changes nothing on THIS side:
// the person's next lines keep arriving from the platform, stored and broadcast, until the
// platform's own ban (fanned out from web, fire-and-forget) takes effect — seconds on Kick, and
// never when that fan-out fails. POST /chat drops a held sender's line before it is stored.
//
// Where a hold comes from — each from its own source of truth, so a restart rebuilds the same set:
//   • a SITE ban (site.bans, by matrix id) holds every canonical identity linked to that account
//     (site.platform_links, and the account's own native link in stream.links) until it expires;
//   • a ban of a PLATFORM-ONLY chatter (no site account; web writes only a mod_log row and fans out)
//     holds that canonical for PLATFORM_HOLD_MS. The platform's own ban is what keeps them out after
//     that — the design web/app/api/mod/ban/route.ts states — so this hold bridges its delay rather
//     than becoming a second, diverging ban list.
// Web PUSHES each ban and unban (POST /chat/ban) so it applies within the request; the table is
// also rebuilt from the database at boot and every REFRESH_MS, which covers a push lost to a
// restart. The rebuild never undoes a push that landed while it was reading.

const { NATIVE_SQL } = require('./native-platform');

const PLATFORM_HOLD_MS = 15 * 60_000;
const REFRESH_MS = 60_000;
const MAX_HELD = 20_000;
const CANONICAL_RE = /^[0-9a-f]{12}$/i;
const MATRIX_ID_RE = /^@[^:\s]{1,255}:[^\s]{1,255}$/;

const SITE_BANS_SQL =
  `SELECT ids.canonical, b.expires_at
     FROM site.bans b
     JOIN (SELECT matrix_id, canonical_id AS canonical FROM site.platform_links
           UNION
           SELECT platform_id, canonical FROM stream.links WHERE platform IN ${NATIVE_SQL}) ids
       ON ids.matrix_id = b.matrix_id
    WHERE b.expires_at IS NULL OR b.expires_at > now()`;
// The last ban-or-unban of each canonical target inside the bridge window.
const PLATFORM_BANS_SQL =
  `SELECT DISTINCT ON (target_id) target_id, action, expires_at, created_at
     FROM site.mod_log
    WHERE action IN ('ban', 'timeout', 'unban')
      AND target_id ~ '^[0-9a-f]{12}$'
      AND created_at > now() - make_interval(secs => $1)
    ORDER BY target_id, created_at DESC`;
const CANONICALS_OF_SQL =
  `SELECT canonical_id AS canonical FROM site.platform_links WHERE matrix_id = ANY($1::text[])
   UNION
   SELECT canonical FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = ANY($1::text[])`;

const msOf = (v) => (v == null ? Infinity : new Date(v).getTime());

/**
 * @param {object} o
 * @param {{ query: Function }} o.pool
 * @param {() => number} [o.now]
 */
function createBanHold({ pool, now = () => Date.now(), log = console, schedule = setInterval, cancel = clearInterval }) {
  let held = new Map();        // canonical → until (ms; Infinity = until lifted)
  const pushedAt = new Map();  // canonical → ms of the last push about it (a rebuild must not undo it)
  let handle = null;

  function isHeld(canonicalId) {
    if (!canonicalId) return false;
    const until = held.get(canonicalId);
    if (until === undefined) return false;
    if (until > now()) return true;
    held.delete(canonicalId);
    return false;
  }

  /** A push states the latest mod action, so it SETS the hold (a re-ban to a shorter timeout is
   *  shorter). Capped: never an unbounded map. */
  function hold(canonical, until) {
    if (!held.has(canonical) && held.size >= MAX_HELD) {
      log.warn(`[ban-hold] ${MAX_HELD} holds — not adding another until the next rebuild`);
      return;
    }
    held.set(canonical, until);
  }

  /** Rebuild from the database. Pushes that arrived while it read stand as pushed. */
  async function refresh() {
    const startedAt = now();
    const [site, plat] = await Promise.all([
      pool.query(SITE_BANS_SQL),
      pool.query(PLATFORM_BANS_SQL, [PLATFORM_HOLD_MS / 1000]),
    ]);
    const next = new Map();
    const put = (c, until) => { if (until > startedAt && (next.get(c) ?? -1) < until) next.set(c, until); };
    for (const r of site.rows) if (r.canonical) put(r.canonical, msOf(r.expires_at));
    for (const r of plat.rows) {
      if (r.action === 'unban') continue;
      put(r.target_id, Math.min(msOf(r.expires_at), new Date(r.created_at).getTime() + PLATFORM_HOLD_MS));
    }
    for (const [c, at] of pushedAt) {
      if (at < startedAt) { pushedAt.delete(c); continue; }
      if (held.has(c)) next.set(c, held.get(c)); else next.delete(c);
    }
    held = next;
    return held.size;
  }

  let running = null;
  let stopped = false;
  function run() {
    if (stopped || running) return running || Promise.resolve();
    running = refresh()
      .catch((e) => log.warn(`[ban-hold] refresh failed: ${e.message}`))
      .finally(() => { running = null; });
    return running;
  }
  function start() {
    run();
    handle = schedule(run, REFRESH_MS);
    handle?.unref?.();
  }
  /** The drain's step before pool.end(): no new rebuild, and resolves when a running one is done. */
  function stop() {
    stopped = true;
    if (handle != null) { cancel(handle); handle = null; }
    return running || Promise.resolve();
  }

  /** A ban or unban from web. Returns { status, body }. */
  async function apply(body) {
    const b = body && typeof body === 'object' ? body : {};
    const canonicalId = typeof b.canonicalId === 'string' && CANONICAL_RE.test(b.canonicalId) ? b.canonicalId.toLowerCase() : null;
    const matrixIds = Array.isArray(b.matrixIds) ? b.matrixIds.filter((m) => typeof m === 'string' && MATRIX_ID_RE.test(m)).slice(0, 50) : [];
    if (b.canonicalId !== undefined && !canonicalId) return { status: 400, body: { error: 'canonicalId must be a 12-hex canonical id' } };
    if (!canonicalId && matrixIds.length === 0) return { status: 400, body: { error: 'canonicalId or matrixIds required' } };
    const lift = b.lift === true;
    let expiresMs = Infinity;
    if (!lift && b.expiresAt != null) {
      expiresMs = Date.parse(b.expiresAt);
      if (!Number.isFinite(expiresMs)) return { status: 400, body: { error: 'expiresAt must be an ISO time or null' } };
    }
    const fromSite = matrixIds.length
      ? (await pool.query(CANONICALS_OF_SQL, [matrixIds])).rows.map((r) => r.canonical).filter(Boolean)
      : [];
    const t = now();
    const touched = new Set();
    for (const c of fromSite) {
      touched.add(c);
      if (lift) held.delete(c); else hold(c, expiresMs);
      pushedAt.set(c, t);
    }
    if (canonicalId) {
      touched.add(canonicalId);
      if (lift) {
        held.delete(canonicalId);
      } else {
        // A linked canonical is held by its site ban above; on its own it is the platform's bridge.
        hold(canonicalId, fromSite.includes(canonicalId) ? expiresMs : Math.min(expiresMs, t + PLATFORM_HOLD_MS));
      }
      pushedAt.set(canonicalId, t);
    }
    return { status: 200, body: { ok: true, lifted: lift, identities: touched.size } };
  }

  function registerBanHoldRoutes(app, { requireInternal, wrap }) {
    // POST /chat/ban { canonicalId?, matrixIds?, expiresAt?: ISO|null, lift?: true } — web, right
    // after it writes a ban or unban (web/app/api/mod/ban/route.ts).
    app.post('/chat/ban', requireInternal, wrap(async (req, res) => {
      const r = await apply(req.body);
      res.status(r.status).json(r.body);
    }));
  }

  return { isHeld, apply, refresh, start, stop, registerBanHoldRoutes, size: () => held.size };
}

module.exports = { createBanHold, PLATFORM_HOLD_MS };
