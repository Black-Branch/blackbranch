// ── WebSocket hub ───────────────────────────────────────────────────────────
// The broadcast-only public surface: website viewers, OBS overlays and popouts
// RECEIVE `history`/live frames and never send an app-level message the server
// processes (only pong/error are handled).

const { WebSocketServer } = require('ws');

/**
 * @param {object} opts
 * @param {import('http').Server} opts.server
 * @param {Array<() => object|null>} [opts.connectFrames] — state-frame builders
 *   pushed to every client right after `history`, so an overlay that (re)loads
 *   paints NOW rather than on the next heartbeat: `timerState` (15s cadence)
 *   and `sponsorState` (a 60s resync floor — without this the credit line sits
 *   blank for up to a minute after every OBS refresh). Each is called
 *   per connection and may throw or return null; both are skipped.
 */
function createWsHub({ server, connectFrames = [], isInternalUpgrade = () => false, maxClients, maxPerAddress, trustedProxies, localReserve }) {
  // Resource caps. This socket is broadcast-only, so:
  //   • maxPayload — bound inbound frames hard. Default ws is 100MB; nothing here needs
  //     more than control-frame + protocol overhead, so a small cap costs nothing and
  //     kills the "one giant frame exhausts memory" vector. Env-overridable just in case.
  //   • connection cap — refuse new upgrades past a ceiling so a connection flood can't
  //     grow wss.clients (and the per-broadcast fan-out) without bound. The default is
  //     generous (well above realistic concurrent website WS for this stream — most
  //     viewers watch on Twitch/YT, not the site) so it acts as a runaway backstop, not
  //     a throttle on real audience; tune via MAX_WS_CLIENTS. We log every refusal.
  // NOT capped here: an Origin allowlist. Legit consumers include OBS browser sources
  // whose Origin can be null/opaque, and rejecting the wrong one is a live-stream outage.
  // This socket carries only public broadcast data with no cookies/credentials/mutations,
  // so CSWSH risk is low; an Origin check needs a verified inventory of real overlay origins.
  const WS_MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD || String(64 * 1024), 10);
  const MAX_WS_CLIENTS = maxClients ?? parseInt(process.env.MAX_WS_CLIENTS || '5000', 10);
  // Per-address cap (R2-8). The global cap alone let ONE host fill the socket — `ws`
  // clients auto-pong, so the heartbeat never reaps an idle flood — and then every
  // overlay, every viewer's chat and web's internal socket got 503: alerts and the timer
  // dark on stream. Generous on purpose: one OBS machine runs a browser source per
  // overlay (alerts, timer, bar, credit, night, meter, sticker, poll…), all from one address.
  const MAX_WS_PER_ADDRESS = maxPerAddress ?? parseInt(process.env.MAX_WS_PER_ADDRESS || '32', 10);
  // Headroom under the global cap kept for sockets from the install's own network (an OBS
  // machine's overlays connect without the secret): a public flood stops this many short of
  // MAX_WS_CLIENTS, and only a local-network socket may use the rest. See isLocalDirect.
  const WS_LOCAL_RESERVE = Math.min(MAX_WS_CLIENTS, localReserve ?? parseInt(process.env.WS_LOCAL_RESERVE || '64', 10));
  // Whose CF-Connecting-IP to believe (see addressKey). The owner box lists its tunnel host.
  const TRUSTED_PROXIES = parseTrustedProxies(trustedProxies ?? process.env.WS_TRUSTED_PROXIES);
  // Open public sockets per address. A socket is counted when it connects and given back
  // when it closes; internal sockets are never counted.
  const perAddress = new Map();
  // noServer + one upgrade listener of our own: a path in `upgradeRoutes` (the rig page's /rig,
  // rig.js) goes to its own handler; every other upgrade is this broadcast socket, as before.
  // Two WebSocketServers on one http server would each try to answer every upgrade.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD,
    verifyClient: (info, done) => {
      // Called at the HTTP upgrade, before the ws is allocated — reject pre-allocation.
      // `wss` is initialised synchronously below; by the time this runs it is bound.
      const headers = (info && info.req && info.req.headers) || {};
      // A secret-bearing upgrade (web's server, stream-ingest: the config_changed
      // channel) is never refused for capacity — a public flood must not be able to
      // cut the install's own control traffic.
      if (isInternalUpgrade(headers)) return done(true);
      // An overlay on the install's own network, connecting straight to this port: exempt from
      // the per-address cap (one OBS machine runs a source per overlay) and allowed into the
      // reserved headroom, so a public flood cannot black out the stream's own overlays.
      const local = isLocalDirect(info.req, TRUSTED_PROXIES);
      const ceiling = local ? MAX_WS_CLIENTS : MAX_WS_CLIENTS - WS_LOCAL_RESERVE;
      if (wss.clients.size >= ceiling) {
        console.warn(`[WS] refused connection — at capacity (${wss.clients.size}/${ceiling}${local ? '' : `, ${WS_LOCAL_RESERVE} kept for local overlays`})`);
        return done(false, 503, 'server at capacity');
      }
      if (local) return done(true);
      const key = addressKey(info.req, TRUSTED_PROXIES);
      const n = perAddress.get(key) || 0;
      if (n >= MAX_WS_PER_ADDRESS) {
        console.warn(`[WS] refused connection — ${n} open from one address (cap ${MAX_WS_PER_ADDRESS})`);
        return done(false, 429, 'too many connections from this address');
      }
      done(true);
    },
  });

  const upgradeRoutes = new Map();
  server.on('upgrade', (req, socket, head) => {
    const url = String(req.url || '/');
    const q = url.indexOf('?');
    const route = upgradeRoutes.get(q === -1 ? url : url.slice(0, q));
    if (route) { route(req, socket, head); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  /** Hand upgrades on one exact path to another handler (it owns the socket from then on). */
  function routeUpgrade(path, handler) {
    if (upgradeRoutes.has(path)) throw new Error(`an upgrade route for ${path} exists already`);
    upgradeRoutes.set(path, handler);
  }

  // Circular buffer: last 200 messages for catch-up on new connections
  const MSG_BUFFER_SIZE = 200;
  const msgBuffer = [];

  // The `history` frame serialized once per buffer CHANGE, not once per
  // connection, so a reconnect storm does not stringify the full buffer per socket. Every mutation of msgBuffer or its
  // entries MUST invalidate — redactBuffered especially: redaction exists
  // because this buffer is replayed to every future connection, and a stale
  // cached string would keep serving the deleted content. Pinned by
  // ws-history-cache.test.js.
  const history = makeHistoryCache(msgBuffer);

  // Mark a buffered message deleted AND strip its content.
  //
  // Flagging `deleted = true` alone was not enough: the buffered object keeps its
  // full text, and the whole buffer is replayed verbatim as `history` to EVERY
  // client on connect. So a moderator deleting a slur removed it from live view
  // while the words kept being re-broadcast to every reconnecting viewer and OBS
  // overlay — the deletion was cosmetic.
  //
  // Redact the content and keep the envelope (id/platform/username) so clients can
  // still reconcile the row as deleted. Moderators who need the original text have
  // the mod panel's chat-history tool, which reads the DB rather than this buffer.
  function redactBuffered(b) {
    if (!b) return;
    b.deleted = true;
    if (b.message) b.message = '';
    if (b.emoteUrl) b.emoteUrl = null;
    if (b.emoteName) b.emoteName = null;
    history.invalidate();
  }

  function bufferPush(msg) {
    msgBuffer.push(msg);
    if (msgBuffer.length > MSG_BUFFER_SIZE) msgBuffer.shift();
    history.invalidate();
  }

  // Like bufferPush, but first drops any earlier buffered entry for the same
  // (platform,id) — for messages that get RE-broadcast under their original id
  // (currently only sticker boosts: the same row updated in place, possibly
  // several times). Without this, msgBuffer accumulates one entry per boost, and
  // a client that (re)connects gets `history` with both the pre- and post-boost
  // snapshots — mergeMessages dedupes against what's already rendered, but NOT
  // within a single incoming batch, so both would render as separate rows.
  function bufferReplace(msg) {
    for (let i = msgBuffer.length - 1; i >= 0; i--) {
      if (msgBuffer[i].platform === msg.platform && msgBuffer[i].id === msg.id) msgBuffer.splice(i, 1);
    }
    bufferPush(msg);
    history.invalidate();
  }

  /** Internal control traffic (the instance settings layer's config_changed / config_test):
   *  ONLY to sockets that authenticated with the bearer secret at upgrade — web's server and
   *  stream-ingest. Never to a browser or an overlay. */
  function sendInternal(payload) {
    const data = JSON.stringify(payload);
    let n = 0;
    wss.clients.forEach((client) => {
      if (client.internal === true && client.readyState === 1) { client.send(data); n++; }
    });
    return n;
  }

  // Two serializations of one frame: the full one for the install's internal sockets (the chat
  // bot keys its memory on the canonical id), the PUBLIC one — no canonical id anywhere in it —
  // for every browser and overlay. Each is made once per broadcast, and the full one only when
  // it differs and an internal socket is listening.
  function broadcast(payload) {
    const pub = publicJson(payload);
    let full = null;
    wss.clients.forEach(client => {
      if (client.readyState !== 1) return;
      if (client.internal === true) {
        if (full === null) full = JSON.stringify(payload);
        client.send(full);
      } else {
        client.send(pub);
      }
    });
  }

  // Heartbeat: mark each socket alive on pong; a sweep terminates any that didn't
  // answer the previous ping. Without this, half-open/zombie sockets accumulate in
  // wss.clients over a long stream and slow broadcast fan-out for everyone.
  //
  // Outbound backpressure: the sweep also terminates any client whose
  // bufferedAmount exceeds WS_MAX_BUFFERED — a client that keeps PONGING but stops
  // READING (wedged tab, throttled radio) passes the liveness check forever while
  // every broadcast accumulates in server memory for it. The cap must sit well
  // above one full `history` replay (~200 msgs, buffered in one burst at connect);
  // 1MB is ~5× that, so only a genuinely stuck reader crosses it.
  const HEARTBEAT_MS = 30_000;
  const WS_MAX_BUFFERED = parseInt(process.env.WS_MAX_BUFFERED || String(1024 * 1024), 10);

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.internal = Boolean(req && req.headers && isInternalUpgrade(req.headers));
    if (!ws.internal && !isLocalDirect(req, TRUSTED_PROXIES)) {
      const key = addressKey(req, TRUSTED_PROXIES);
      perAddress.set(key, (perAddress.get(key) || 0) + 1);
      ws.once('close', () => {
        const left = (perAddress.get(key) || 1) - 1;
        if (left > 0) perAddress.set(key, left); else perAddress.delete(key);
      });
    }
    ws.on('pong', () => { ws.isAlive = true; });
    // First frame on every socket: whether the hub took it as INTERNAL (the bearer secret
    // matched). A process that sent the secret and hears `internal: false` knows its secret is
    // wrong or missing — without this, an internal client silently degrades to a public one
    // (no canonical ids) and nothing says so.
    try { ws.send(JSON.stringify({ type: 'hello', internal: ws.internal })); } catch { /* socket already closing */ }
    // Send recent message history on connect
    if (msgBuffer.length) {
      ws.send(history.get(ws.internal));
    }
    // Then the current state frames (see connectFrames above). After history,
    // so a consumer that folds both sees the newest state last.
    for (const build of connectFrames) {
      let frame = null;
      try { frame = build(); } catch (e) { console.warn('[WS] connect frame failed:', e.message); }
      if (frame && typeof frame === 'object') {
        try { ws.send(ws.internal ? JSON.stringify(frame) : publicJson(frame)); } catch { /* socket already closing */ }
      }
    }
    ws.on('error', (err) => console.error('[WS] Client error:', err.message));
  });

  const wsHeartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const verdict = sweepVerdict(ws, WS_MAX_BUFFERED);
      if (verdict !== 'ping') {
        if (verdict === 'backpressure') {
          console.warn(`[WS] terminated slow reader — ${ws.bufferedAmount} bytes buffered (cap ${WS_MAX_BUFFERED})`);
        }
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already closing */ }
    });
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(wsHeartbeat));

  return { wss, msgBuffer, broadcast, sendInternal, bufferPush, bufferReplace, redactBuffered, routeUpgrade };
}

// "::ffff:192.0.2.1" and "192.0.2.1" are the same IPv4 peer.
function normAddr(a) {
  const s = String(a || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

// The proxies whose CF-Connecting-IP header is believed: WS_TRUSTED_PROXIES, a
// comma-separated list of socket addresses (the tunnel connector's host). Empty —
// the default — believes the header from nobody.
function parseTrustedProxies(value) {
  return new Set(String(value || '').split(',').map(normAddr).filter(Boolean));
}

// An IPv6 client controls its whole /64 (one customer prefix), so counting per /128 gave one
// host 2^64 buckets. IPv6 is counted per /64; IPv4 per address.
function bucketOf(addr) {
  const a = normAddr(addr);
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('%')[0].toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = a.includes('::') && tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a; // not IPv6 after all
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// A private, loopback or link-local address: the install's own network.
function isPrivateAddress(addr) {
  const a = normAddr(addr).toLowerCase();
  if (/^(10|127)\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d{1,3})\./.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return a === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(a) || /^fe[89ab][0-9a-f]?:/.test(a);
}

// A socket from the install's own network that reached this port DIRECTLY — not through the
// tunnel. Two things rule out the tunnel: the socket is not a trusted proxy, and it carries no
// CF-Connecting-IP (every request through the tunnel does, so a tunnel host missing from
// WS_TRUSTED_PROXIES never makes public traffic look local). Used for capacity only, never auth.
function isLocalDirect(req, trusted) {
  const sock = normAddr(req && req.socket && req.socket.remoteAddress);
  if (!sock || trusted.has(sock)) return false;
  const cf = req && req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return false;
  return isPrivateAddress(sock);
}

// The address a connection is COUNTED under for the per-address cap. Public
// traffic reaches this process from the tunnel host, so the socket address alone
// would put every viewer in one bucket; Cloudflare's CF-Connecting-IP names the
// real client — but ONLY when the socket is one of the trusted proxies. From any
// other peer (the LAN, anything reaching the port without the tunnel) the header
// is ignored: otherwise a client could send a different value per socket and
// never fill a bucket. Used for LIMITING only, never for auth — that is
// isInternalUpgrade's secret, never an address.
let warnedUntrustedHeader = false;
function addressKey(req, trusted) {
  const sock = normAddr(req && req.socket && req.socket.remoteAddress) || '?';
  const cf = req && req.headers && req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) {
    if (trusted.has(sock)) return `cf:${bucketOf(cf.trim().slice(0, 64))}`;
    if (!warnedUntrustedHeader) {
      warnedUntrustedHeader = true;
      // Once per process: on a box whose tunnel host is missing from the list,
      // every viewer shares the tunnel host's one bucket, and this says why.
      console.warn(`[WS] CF-Connecting-IP from ${sock}, which is not in WS_TRUSTED_PROXIES — ` +
        'ignored; connections from it are counted as one address');
    }
  }
  return `sock:${bucketOf(sock)}`;
}

// One client's fate at each heartbeat sweep. Dead is checked FIRST: a client
// that stopped ponging also stopped reading, so its buffer is high too, and
// reporting every ordinary zombie as backpressure would bury the new signal.
function sweepVerdict(ws, maxBuffered) {
  if (ws.isAlive === false) return 'dead';
  if (ws.bufferedAmount > maxBuffered) return 'backpressure';
  return 'ping';
}

// Lazy one-slot cache for the serialized history frame. Exported pure so the
// staleness/invalidation contract is testable without a live server.
// The keys a frame may carry for the install's own internal sockets but never for a public one.
// `canonicalId` is one person's id across every platform: on the public socket (no sign-in) it let
// anyone group a person's Twitch, YouTube, Kick and site lines and read who is who. Public frames
// carry the per-platform `publicId` instead (pseudonym.js). Stripped at ANY depth, so a frame
// added later that nests one (a card, a `history` batch) cannot carry it out by accident.
const INTERNAL_ONLY_KEYS = new Set(['canonicalId']);
function publicReplacer(key, value) { return INTERNAL_ONLY_KEYS.has(key) ? undefined : value; }
/** A frame as a public socket receives it. */
function publicJson(payload) { return JSON.stringify(payload, publicReplacer); }

// The `history` replay, cached per buffer change in its two forms (internal and public). One
// invalidate clears both, so a redaction can never survive in either.
function makeHistoryCache(buffer) {
  let full = null;
  let pub = null;
  return {
    invalidate() { full = null; pub = null; },
    get(internal = false) {
      if (internal) {
        if (full === null) full = JSON.stringify({ type: 'history', messages: buffer });
        return full;
      }
      if (pub === null) pub = publicJson({ type: 'history', messages: buffer });
      return pub;
    },
  };
}

module.exports = { createWsHub, sweepVerdict, makeHistoryCache, bucketOf, isLocalDirect };
