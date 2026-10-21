// ── Internal-caller auth ────────────────────────────────────────────────────
// stream-api sits behind a public Cloudflare Tunnel (the API origin). All HTTP
// endpoints are internal-only; the sole public surface is the read-only
// WebSocket. A caller is trusted if it presents the shared secret OR connects
// from an internal source IP the tunnel cannot impersonate.
//
// The tunnel connector's host is the tunnel's egress IP, so it is NOT in
// the IP allowlist — a web server there must use the secret instead.
// Co-located local services (anything on 127.0.0.1) pass on IP alone.
//
// FAIL CLOSED. An opt-in flag would make the default — a fresh deploy, a lost
// .env, a new dev box — warn-and-ALLOW, so every internal route (money,
// moderation, identity, bot config) would answer any caller reaching the public
// tunnel, closed only by configuration, which is exactly what a redeploy drops.
// The opt-out is explicit and local-only.

const crypto = require('crypto');

// Factory (not module-level state) so tests can drive it with a fake env and an
// exit spy — the fail-closed default and the startup fatal are load-bearing
// invariants, and they are only testable if construction is parameterized.
function createAuth({
  env = process.env,
  exit = (code) => process.exit(code),
  warn = (...a) => console.warn(...a),
  error = (...a) => console.error(...a),
} = {}) {
  const STREAM_API_SECRET = env.STREAM_API_SECRET || '';
  const ENFORCE_AUTH      = env.STREAM_API_ENFORCE !== '0';
  // LOOPBACK ONLY. An allowlist entry is not inert: it trusts an address that
  // comes back the moment ANY unrelated machine takes it, silently handing it
  // every internal route (money, moderation, identity, bot config). A dead
  // allowlist entry is a latent grant.
  //
  // Adding an entry here is a real decision — see the test, which pins the
  // whole set rather than just checking membership.
  const INTERNAL_IPS = new Set([
    '127.0.0.1', '::1', '::ffff:127.0.0.1',
  ]);

  // Enforcing without a secret is a trap, not a safe state: IP-trusted localhost
  // callers keep working, so the process looks healthy while a peer host — which can
  // only authenticate BY secret — gets 401 on every request and the whole site
  // goes dark for a reason nothing in the logs points at. Refuse to start, the
  // way DB_PASSWORD does in index.js. Set STREAM_API_ENFORCE=0 for a local run.
  if (ENFORCE_AUTH && !STREAM_API_SECRET) {
    error('[FATAL] STREAM_API_ENFORCE is on but STREAM_API_SECRET is not set — ' +
      'the web server authenticates by secret and would be locked out. ' +
      'Set STREAM_API_SECRET in stream-api/.env, or STREAM_API_ENFORCE=0 for local dev.');
    exit(1);
  }

  function hasValidSecret(req) {
    // The token starts at a non-space, so `\s+` and the token cannot trade characters:
    // `\s+(.+)` backtracked quadratically on a long run of whitespace.
    const m = /^Bearer\s+(\S.*)$/i.exec(req.get('authorization') || '');
    const token = m ? m[1] : '';
    if (!STREAM_API_SECRET || !token) return false;
    const a = Buffer.from(token), b = Buffer.from(STREAM_API_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function requireInternal(req, res, next) {
    if (hasValidSecret(req)) return next();
    // Cross-site browser requests must never ride the IP allowlist:
    // a browser running ON an internal host IS 127.0.0.1 to us, and a hostile
    // page can fire no-preflight POSTs at it. Sec-Fetch-Site is sent by
    // browsers only — server-to-server callers (a peer host, stream-ingest, curl)
    // never send it, and same-origin/none values (overlay pages, direct
    // navigation) still pass — so rejecting exactly 'cross-site' locks out
    // nothing legitimate.
    const crossSite = (req.get('sec-fetch-site') || '').toLowerCase() === 'cross-site';
    if (!crossSite && INTERNAL_IPS.has(req.socket.remoteAddress)) return next();
    const who = `${req.method} ${req.path} from ${req.socket.remoteAddress}${crossSite ? ' (cross-site)' : ''}`;
    if (ENFORCE_AUTH) {
      warn(`[AUTH] DENY ${who} (no secret / non-internal)`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    warn(`[AUTH] ALLOW ${who} — enforcement disabled via STREAM_API_ENFORCE=0`);
    return next();
  }

  // STRICTER than requireInternal, for routes that return or accept SECRET MATERIAL (the
  // instance settings layer's /config routes): the bearer STREAM_API_SECRET and nothing else.
  //   • No IP trust. requireInternal passes 127.0.0.1 without a secret, and since the 5b
  //     cutover everything co-located on the app VM is 127.0.0.1 — other services, any local
  //     tool, and any SSRF in a co-located process (web fetches user-supplied URLs for link
  //     previews). None of those may read a decrypted credential.
  //   • No browser. A request carrying Sec-Fetch-Site came from a browser (Node's fetch does
  //     not send it), and no browser has any business here, same-site or not.
  //   • No STREAM_API_ENFORCE=0 escape hatch: a dev box without a secret simply cannot use
  //     these routes, which is the safe end.
  function requireSecret(req, res, next) {
    if (req.get('sec-fetch-site') != null) {
      warn(`[AUTH] DENY ${req.method} ${req.path} — a browser request (Sec-Fetch-Site) on a secret route`);
      return res.status(403).json({ error: 'forbidden' });
    }
    if (hasValidSecret(req)) return next();
    warn(`[AUTH] DENY ${req.method} ${req.path} from ${req.socket.remoteAddress} — secret route without the secret`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  /** The same secret check for a WebSocket upgrade's headers (ws-hub marks such a socket
   *  INTERNAL; internal-only frames go to those sockets alone). A browser cannot set an
   *  Authorization header on a WebSocket, so a browser socket can never be internal. */
  function isInternalUpgrade(headers) {
    if (headers['sec-fetch-site'] != null) return false;
    const m = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''));
    const token = m ? m[1] : '';
    if (!STREAM_API_SECRET || !token) return false;
    const a = Buffer.from(token), b = Buffer.from(STREAM_API_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return { requireInternal, requireSecret, isInternalUpgrade, hasValidSecret, STREAM_API_SECRET, ENFORCE_AUTH, INTERNAL_IPS };
}

module.exports = { createAuth };
