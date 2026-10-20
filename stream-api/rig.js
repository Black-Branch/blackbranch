// The rig page's server half — part of the `obs` module (config/modules.mjs).
//
// The streamer adds ONE browser source in OBS: <site>/overlay/rig?key=…. That page connects OUT to
// this process at wss://<api>/rig, so it works from any network; this process never opens a
// connection toward the streaming PC. Over that socket:
//   • sounds and TTS: a frame carries a short-lived signed path to the clip (GET /rig/clip/:id),
//     the page plays it with an <audio> element, and the browser source's own audio puts it in
//     the OBS mix. The page reports when the clip ended — the drain signal the TTS queue awaits.
//   • the bot's avatar: the same speaking latch obs.setSpeaking drives.
//   • scenes: the page reports OBS's scene (window.obsstudio) and switches it on request, which
//     needs the source's page permission at "Advanced access to OBS".
//
// Protocol (page ⇄ server, JSON text frames; web/app/overlay/rig/rigProtocol.ts is the page's
// copy and rigProtocol.test.ts holds the two to the same names):
//   upgrade        Sec-WebSocket-Protocol: rig.v1, rig-key.<key> — checked BEFORE the socket exists
//   page → server  rig.hello {level, scene, scenes}   (OBS's state; it may come late or never)
//                  rig.started {id, durationMs} · rig.ended {id, error?} · rig.scene {name, scenes?}
//   server → page  rig.welcome {speaking} · rig.play {id, url, kind} · rig.stop {id}
//                  rig.speaking {on} · rig.setScene {name}
// These go to rig pages only, never to the public broadcast socket (ws-hub.js).
//
// The page's key is DERIVED, never stored: HMAC(STREAM_API_SECRET, generation). "Regenerate" bumps
// the generation (instance key obs.rigKeyVersion, written through this process's own write) and
// closes every page that used the old key. Clip links are signed with a key made at boot and held in memory —
// the clips themselves live in memory too, so a restart loses both together and no secret is
// stored anywhere for them.

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { instanceConfig } = require('./instance-config');

const PATH = '/rig';
const HEARTBEAT_MS = 30_000;
// The rig path's own limits — its sockets are a separate pool from the viewers' broadcast socket
// (ws-hub MAX_WS_CLIENTS), and only a request carrying this install's key gets a socket at all,
// so neither a viewer flood nor a stream of keyless upgrades can keep the streamer's page out.
const MAX_PAGES = 8;            // for the install's one key; one is normal
const MAX_PAGES_PER_ADDRESS = 4;
const PROTOCOL = 'rig.v1';
const KEY_PROTOCOL = 'rig-key.';
const MAX_FRAME = 16 * 1024;    // the page sends small JSON only
// A clip link lives 2 minutes: long enough for a queued clip to be fetched, too short to share.
const CLIP_TTL_MS = 120_000;
const CLIP_MAX_BYTES = 8 * 1024 * 1024;
const STORE_MAX_BYTES = 64 * 1024 * 1024;
// A page that has not started a clip in this long is not playing it; the queue moves on.
const START_WAIT_MS = 10_000;
const END_GRACE_MS = 5_000;
const MAX_PLAY_MS = 10 * 60_000;
// obsstudio.getControlLevel(): 0 none · 1 read OBS · 2 read user · 3 basic · 4 advanced · 5 all.
const LEVEL_ADVANCED = 4;
const NAME_MAX = 256;
const SCENES_MAX = 200;

const ID_RE = /^[0-9a-f]{32}$/;

/** Short, fixed words for the content type, sniffed from the bytes (the TTS temp file is always
 *  named .mp3; a test clip is WAV). */
function contentType(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  return 'audio/mpeg';
}

/**
 * A short WAV made here, for the OBS page's two test buttons — no file, no provider.
 * 'voice' is a run of syllable-like tones (it moves the avatar's mouth like speech);
 * 'sound' is a two-note chime.
 * @param {'voice'|'sound'} what
 */
function testClip(what) {
  const rate = 22050;
  const parts = what === 'voice'
    ? [[220, 180], [262, 160], [0, 60], [247, 200], [196, 220], [0, 80], [233, 180], [208, 260]]
    : [[880, 180], [1320, 320]];
  const total = parts.reduce((n, [, ms]) => n + Math.round((rate * ms) / 1000), 0);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(total * 2, 40);
  let at = 0;
  for (const [hz, ms] of parts) {
    const n = Math.round((rate * ms) / 1000);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400, (n - i) / 400); // short fades: no clicks
      const v = hz ? Math.sin((2 * Math.PI * hz * i) / rate) * 0.5 * env : 0;
      buf.writeInt16LE(Math.round(v * 32767), 44 + (at + i) * 2);
    }
    at += n;
  }
  return buf;
}

/**
 * @param {object} o
 * @param {{ get(key: string): any, writeInternal?: Function }} [o.config]
 * @param {() => number} [o.now]
 * @param {Pick<Console, 'log'|'warn'>} [o.log]
 * @param {{ startWaitMs?: number, endGraceMs?: number }} [o.timing]  tests shorten these
 */
function createRig({ config = instanceConfig, now = Date.now, log = console, timing = {} } = {}) {
  const T = { startWaitMs: START_WAIT_MS, endGraceMs: END_GRACE_MS, ...timing };
  let secret = '';
  let started = false;
  const clipKey = crypto.randomBytes(32);
  // Answer with the protocol name only: the key offered beside it is never echoed back.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, handleProtocols: (offered) => (offered.has(PROTOCOL) ? PROTOCOL : false) });
  /** @type {Set<{ ws: any, since: number, address: string, level: number|null, scene: string|null, scenes: string[] }>} */
  const pages = new Set();
  /** id → { buf, type, exp } */
  const clips = new Map();
  /** id → { finish: () => void, started: boolean, timer: any } */
  const plays = new Map();
  const sceneCbs = new Set();
  let speaking = false;
  let lastScene = null;

  // ── the key ─────────────────────────────────────────────────────────────────────────────
  const keyVersion = () => {
    const v = config.get('obs.rigKeyVersion');
    return Number.isInteger(v) && v > 0 ? v : 0;
  };
  /** The page key for the current generation, or null when this process has no secret. */
  function key() {
    if (!secret) return null;
    return crypto.createHmac('sha256', secret).update(`rig-page-key:${keyVersion()}`).digest('base64url').slice(0, 32);
  }
  function keyMatches(given) {
    const k = key();
    if (!k || typeof given !== 'string' || !given) return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(k).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // ── sockets ─────────────────────────────────────────────────────────────────────────────
  const send = (ws, frame) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); } catch { /* closing */ } };
  const toAll = (frame, filter = () => true) => {
    let n = 0;
    for (const p of pages) if (filter(p)) { send(p.ws, frame); n++; }
    return n;
  };
  const newest = () => { let last = null; for (const p of pages) last = p; return last; };

  function noteScene(name) {
    if (!name || name === lastScene) return;
    lastScene = name;
    for (const cb of sceneCbs) { try { cb(name); } catch (e) { log.warn(`[rig] scene callback: ${e.message}`); } }
  }

  const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const sceneList = (v) => (Array.isArray(v) ? v.map((s) => str(s, NAME_MAX)).filter(Boolean).slice(0, SCENES_MAX) : null);
  const level = (v) => (Number.isInteger(v) && v >= 0 && v <= 5 ? v : null);

  function onPageMessage(page, msg) {
    if (msg.type === 'rig.started' && ID_RE.test(msg.id)) {
      const p = plays.get(msg.id);
      if (!p || p.started) return;
      p.started = true;
      clearTimeout(p.timer);
      const ms = Number.isFinite(msg.durationMs) && msg.durationMs > 0 ? Math.min(msg.durationMs, MAX_PLAY_MS) : MAX_PLAY_MS;
      p.timer = setTimeout(p.finish, ms + T.endGraceMs);
    } else if (msg.type === 'rig.ended' && ID_RE.test(msg.id)) {
      const p = plays.get(msg.id);
      if (p) {
        if (msg.error) log.warn('[rig] the page could not play a clip');
        p.finish();
      }
    } else if (msg.type === 'rig.scene') {
      const name = str(msg.name, NAME_MAX);
      const scenes = sceneList(msg.scenes);
      if (scenes) page.scenes = scenes;
      if (name) { page.scene = name; if (page === newest()) noteScene(name); }
    }
  }

  function onConnection(ws, address) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* the close handler tidies up */ });
    const page = { ws, since: now(), address, level: null, scene: null, scenes: [] };
    pages.add(page);
    log.log(`[rig] page connected (${pages.size} now)`);
    send(ws, { type: 'rig.welcome', speaking });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'rig.hello') {
        page.level = level(msg.level);
        page.scene = str(msg.scene, NAME_MAX);
        page.scenes = sceneList(msg.scenes) || [];
        log.log(`[rig] page reports OBS page permission ${page.level ?? 'n/a'}`);
        if (page.scene && page === newest()) noteScene(page.scene);
        return;
      }
      onPageMessage(page, msg);
    });
    ws.on('close', () => {
      pages.delete(page);
      log.log(`[rig] page disconnected (${pages.size} now)`);
      // Nobody left to play what is queued: the queue must not wait on a page that is gone.
      if (!pages.size) for (const p of [...plays.values()]) p.finish();
    });
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  /** The bucket a page counts against: the front door's client address (Caddy and cloudflared
   *  overwrite CF-Connecting-IP), else the socket's. Only a key holder reaches this count. */
  function addressOf(req) {
    const h = req.headers['cf-connecting-ip'];
    return (typeof h === 'string' && h.trim()) || req.socket.remoteAddress || '?';
  }
  /** The key a request offers in Sec-WebSocket-Protocol (a browser cannot set other headers). */
  function offeredKey(req) {
    const list = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim());
    const k = list.find((x) => x.startsWith(KEY_PROTOCOL));
    return k ? k.slice(KEY_PROTOCOL.length) : '';
  }
  const refuse = (socket, status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  /** ws-hub hands every upgrade on PATH here (routeUpgrade). Every refusal is an HTTP answer before
   *  any socket or page state exists: off 404 · no or wrong key 401 · too many from one address 429
   *  · too many in all 503. */
  function handleUpgrade(req, socket, head) {
    if (!started) return refuse(socket, '404 Not Found');
    if (!keyMatches(offeredKey(req))) return refuse(socket, '401 Unauthorized');
    const address = addressOf(req);
    if ([...pages].filter((p) => p.address === address).length >= MAX_PAGES_PER_ADDRESS) return refuse(socket, '429 Too Many Requests');
    if (pages.size >= MAX_PAGES) return refuse(socket, '503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, address));
  }

  // ── clips ───────────────────────────────────────────────────────────────────────────────
  const sign = (id, exp) => crypto.createHmac('sha256', clipKey).update(`${id}.${exp}`).digest('base64url');

  function sweep() {
    const t = now();
    for (const [id, c] of clips) if (c.exp <= t) clips.delete(id);
    let bytes = 0;
    for (const c of clips.values()) bytes += c.buf.length;
    for (const [id, c] of clips) { if (bytes <= STORE_MAX_BYTES) break; clips.delete(id); bytes -= c.buf.length; }
  }

  /** GET /rig/clip/:id?exp=&sig= — the clip's bytes while its link is valid. */
  function serveClip(req, res) {
    res.set('Cache-Control', 'no-store');
    sweep();
    const id = String(req.params.id || '');
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    const c = ID_RE.test(id) ? clips.get(id) : null;
    const want = Number.isInteger(exp) ? Buffer.from(sign(id, exp)) : null;
    const got = Buffer.from(sig);
    const valid = want && got.length === want.length && crypto.timingSafeEqual(got, want) && exp > now();
    if (!valid || !c || c.exp !== exp) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', c.type);
    res.set('Content-Length', String(c.buf.length));
    return res.end(c.buf);
  }

  /**
   * Play a file on every connected rig page. Null when no page is connected (the sink then falls
   * through). Same contract as the satellite's play(): `done` resolves when the clip has ended on
   * a page (or the backstops fire) and never rejects; kill() stops it.
   * @param {string} file
   * @param {{ kind?: 'tts'|'sound' }} [o]
   */
  function play(file, { kind = 'sound' } = {}) {
    if (!started || !pages.size) return null;
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { log.warn(`[rig] cannot read a clip: ${e.message}`); return null; }
    if (buf.length > CLIP_MAX_BYTES) { log.warn(`[rig] clip too large for the rig page (${buf.length} bytes)`); return null; }
    sweep();
    const id = crypto.randomBytes(16).toString('hex');
    const exp = now() + CLIP_TTL_MS;
    clips.set(id, { buf, type: contentType(buf), exp });
    let finish;
    const done = new Promise((resolve) => {
      finish = () => {
        const p = plays.get(id);
        if (p) { clearTimeout(p.timer); plays.delete(id); }
        resolve();
      };
    });
    plays.set(id, { finish, started: false, timer: setTimeout(() => finish(), T.startWaitMs) });
    toAll({ type: 'rig.play', id, url: `${PATH}/clip/${id}?exp=${exp}&sig=${sign(id, exp)}`, kind: kind === 'tts' ? 'tts' : 'sound' });
    return {
      done,
      kill: () => { toAll({ type: 'rig.stop', id }); finish(); },
    };
  }

  function setSpeaking(on) {
    speaking = !!on;
    toAll({ type: 'rig.speaking', on: speaking });
  }

  /** Ask the rig page to switch OBS's program scene. */
  function switchScene(name) {
    const n = str(name, NAME_MAX);
    if (!n) return { ok: false, code: 'bad_name' };
    if (!started) return { ok: false, code: 'off' };
    if (!pages.size) return { ok: false, code: 'not_connected' };
    const able = [...pages].filter((p) => (p.level ?? 0) >= LEVEL_ADVANCED);
    if (!able.length) return { ok: false, code: 'no_permission' };
    if (!able.some((p) => p.scenes.includes(n))) return { ok: false, code: 'unknown_scene' };
    toAll({ type: 'rig.setScene', name: n }, (p) => (p.level ?? 0) >= LEVEL_ADVANCED);
    return { ok: true, code: 'sent' };
  }

  function status() {
    const list = [...pages].map((p) => ({ since: new Date(p.since).toISOString(), level: p.level, scene: p.scene }));
    const scenes = [...new Set([...pages].flatMap((p) => p.scenes))];
    return { on: started, connected: list.length, pages: list, scenes, scene: newest()?.scene ?? null, speaking };
  }

  /** Close every page (a new key, or shutdown). */
  function closeAll(code, why) {
    for (const ws of wss.clients) { try { ws.close(code, why); } catch { /* gone */ } }
  }

  /**
   * The OBS page's routes, on the obs module's router (mounted only while the module is on).
   * @param {import('express').Router} app
   * @param {{ requireSecret: Function, wrap: Function, speakTest: () => unknown, soundTest: () => unknown, which: () => string }} deps
   */
  function registerRigRoutes(app, { requireSecret, wrap, speakTest, soundTest, which }) {
    // Public on purpose: an <audio> element sends no secret. The signed, 2-minute link is the guard.
    app.get('/rig/clip/:id', (req, res) => serveClip(req, res));
    app.get('/rig/status', requireSecret, (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ ...status(), key: key(), keyVersion: keyVersion(), sink: which() });
    });
    app.post('/rig/key', requireSecret, wrap(async (req, res) => {
      const by = typeof req.body?.updatedBy === 'string' ? req.body.updatedBy : '';
      const before = keyVersion();
      const r = await config.writeInternal('obs.rigKeyVersion', before + 1, by);
      if (r.status !== 200) return res.status(r.status).json(r.body);
      // OBS_RIG_KEY_VERSION in the env wins over the saved value: then nothing changed.
      if (keyVersion() === before) return res.status(409).json({ error: 'the key generation is pinned by OBS_RIG_KEY_VERSION in the chat service\'s env' });
      closeAll(4401, 'key changed');
      log.log('[rig] page key regenerated; connected pages closed');
      return res.json({ ok: true, key: key(), keyVersion: keyVersion() });
    }));
    app.post('/rig/scene', requireSecret, (req, res) => {
      const r = switchScene(req.body?.name);
      res.status(r.ok ? 200 : 409).json(r);
    });
    app.post('/rig/test', requireSecret, (req, res) => {
      const what = req.body?.what === 'voice' ? 'voice' : req.body?.what === 'sound' ? 'sound' : null;
      if (!what) return res.status(400).json({ error: 'what must be "voice" or "sound"' });
      if (what === 'voice') speakTest(testClip('voice')); else soundTest(testClip('sound'));
      return res.json({ ok: true, what, sink: which(), pages: pages.size });
    });
  }

  return {
    PATH,
    /** Called once at boot with the process's bearer secret (the key is derived from it). */
    init({ secret: s }) { secret = s || ''; },
    start() { started = true; },
    isStarted: () => started,
    connected: () => pages.size > 0,
    handleUpgrade, play, setSpeaking, switchScene, status, key, keyVersion,
    currentScene: () => newest()?.scene ?? null,
    onSceneChange(cb) { sceneCbs.add(cb); return () => sceneCbs.delete(cb); },
    registerRigRoutes,
    /** Shutdown: close the pages, release every queued clip. */
    stop() {
      clearInterval(heartbeat);
      for (const p of [...plays.values()]) p.finish();
      for (const ws of wss.clients) { try { ws.terminate(); } catch { /* gone */ } }
      wss.close();
    },
  };
}

/** The process singleton (obs.js, rig-sink.js and index.js share it). */
const rig = createRig();

module.exports = { rig, createRig };
