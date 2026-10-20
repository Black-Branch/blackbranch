// The instance settings layer — stream-ingest's reader.
//
// Keys are declared once in config/instance-schema.mjs; ./instanceSchema.generated.js is this package's generated copy.
//
// Precedence for every key, in THIS process: env > database > the schema's neutral default.
// This process has no database access, so the database layer comes from stream-api, which
// owns the tables: GET /config (plain values) and GET /config/secrets?package=stream-ingest
// (credentials stream-api decrypted — it alone holds INSTANCE_MASTER_KEY).
//
// `get(key)` is synchronous and safe before the first load: it then answers from env and
// defaults, exactly as process.env did. index.js calls `start()` in main() before any platform
// starts, so a stored value is in place before anything reads it.
//
// Live: a `config_changed` frame re-reads the layer; a `config_test` frame runs one credential's
// provider check HERE (with this process's own value) and reports the RESULT CODE (never text).
// Both arrive on a socket that authenticates with the bearer secret at upgrade — stream-api
// sends control frames to such sockets only, never to browsers. Every (re)connect re-reads and
// re-reports, a failed read retries every 30 s, and a 5-minute re-read is the backstop for a
// frame missed some other way (e.g. a clear() that reached stream-api while this socket was
// down). The loaded/stale state rides every report, so the Credentials page shows a process
// that is answering from an old layer.
//
// A stored credential stream-api could not decrypt arrives as a NAME in `unreadable`; it
// resolves here as an error (unless env overrides it), never as the default.

import WebSocket from 'ws';
import { INSTANCE_KEYS, instanceEntry, resolveInstanceValue, runProviderCheck } from './instanceSchema.generated.js';
import { streamApiBase, streamApiWsUrl } from './streamApiUrl.js';

const SELF = 'stream-ingest';
const LOAD_TIMEOUT_MS = 8000;
const RECONNECT_MS = 5000;
const RETRY_MS = 30_000;
const BACKSTOP_MS = 5 * 60_000;

/** What may be shown of a secret — mirrors stream-api's rule: last four, only when long. */
function lastFour(value) {
  const s = String(value ?? '');
  return s.length >= 12 ? s.slice(-4) : '';
}
function display(entry, value) {
  if (value === null || value === undefined) return null;
  if (entry.secret) { const l4 = lastFour(value); return l4 ? `…${l4}` : '(set)'; }
  return value;
}

/**
 * @test-only the factory exists so tests build an isolated reader with their own env, fetch
 * and socket; production uses the process singleton `instanceConfig` below.
 */
export function createInstanceConfig({
  env = null,
  fetchImpl = (...a) => fetch(...a),
  WebSocketImpl = WebSocket,
  log = console,
} = {}) {
  const envOf = () => env || process.env;
  let plain = {};
  let secrets = {};
  let content = {};      // key → body (prompts, the bot's behavior file, the help desk's facts)
  let contentReadAt = null; // when a content read last succeeded; null = never (content is then NOT known)
  let unreadable = new Set();
  let loadedAt = null;
  let applied = null; // restart-applied keys, as the first load resolved them
  let failingSince = null;
  let retryTimer = null;
  let backstopTimer = null;
  let ws = null;
  let closed = false;
  let reconnectTimer = null;

  function entryOf(key) {
    // A fixed key, or a concrete key of a pattern (ai.connection.<id>.apiKey).
    const e = instanceEntry(key);
    if (!e) throw new Error(`unknown instance key ${key}`);
    return e;
  }
  function resolveEntry(e) {
    const r = resolveInstanceValue(e, envOf(), e.secret ? secrets : plain);
    if (e.secret && r.source !== 'env' && unreadable.has(e.key)) {
      return { value: null, source: 'database', envName: null, error: 'stored credential cannot be read (stream-api could not decrypt it)' };
    }
    return r;
  }
  function resolve(key) { return resolveEntry(entryOf(key)); }
  function state() {
    return {
      loaded: loadedAt !== null,
      loadedAt: loadedAt !== null ? new Date(loadedAt).toISOString() : null,
      failingSince: failingSince !== null ? new Date(failingSince).toISOString() : null,
    };
  }
  function get(key) { return resolve(key).value; }
  /** An install's content body (prompt.<slot>, bot.behavior, helpdesk.facts), or null. */
  function contentOf(key) { return Object.prototype.hasOwnProperty.call(content, key) ? content[key] : null; }
  /** Has a content read ever succeeded? Until then a missing body means "not known", not "unset". */
  function contentLoaded() { return contentReadAt !== null; }
  // Listeners told after every successful load — the module supervisor reconciles on them.
  const loadListeners = new Set();
  function onLoad(fn) { loadListeners.add(fn); return () => loadListeners.delete(fn); }

  function headers() {
    const secret = envOf().STREAM_API_SECRET || '';
    return { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) };
  }
  async function call(method, path, body) {
    const res = await fetchImpl(`${streamApiBase()}${path}`, {
      method, headers: headers(),
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`stream-api ${method} ${path} -> ${res.status}`);
    return res.json();
  }

  /** Re-read the database layer from stream-api. Resolves true on success, false otherwise —
   *  a failure keeps the previous layer (or env + defaults), never throws. */
  async function load() {
    try {
      // Content is read beside the settings, but a failed content read must not cost the
      // settings (and the credentials) with it: the last content set is kept and it is retried.
      const [cfg, sec, con] = await Promise.all([
        call('GET', '/config'),
        call('GET', `/config/secrets?package=${SELF}`),
        call('GET', '/content').catch((e) => { log.warn(`[instance-config] content read failed: ${e.message} — keeping the last content`); scheduleRetry(); return null; }),
      ]);
      plain = cfg && typeof cfg.values === 'object' && cfg.values ? cfg.values : {};
      secrets = sec && typeof sec.values === 'object' && sec.values ? sec.values : {};
      unreadable = new Set(Array.isArray(sec?.unreadable) ? sec.unreadable : []);
      if (con) {
        const next = {};
        for (const [k, v] of Object.entries(con && typeof con.content === 'object' && con.content ? con.content : {})) {
          if (v && typeof v.body === 'string') next[k] = v.body;
        }
        content = next;
        contentReadAt = Date.now();
      }
      loadedAt = Date.now();
      failingSince = null;
      if (applied === null) {
        // What a restart-applied key is run with: taken once, at the first load (statusReport).
        applied = {};
        for (const e of INSTANCE_KEYS) if (e.reload === 'restart' && e.packages.includes(SELF)) applied[e.key] = resolveEntry(e).value;
      }
      for (const fn of loadListeners) { try { fn(); } catch (e) { log.warn(`[instance-config] load listener: ${e.message}`); } }
      return true;
    } catch (e) {
      if (failingSince === null) failingSince = Date.now();
      log.warn(`[instance-config] load from stream-api failed: ${e.message} — keeping ${loadedAt !== null ? 'the last layer' : 'env + defaults'}; retrying in ${RETRY_MS / 1000}s`);
      scheduleRetry();
      return false;
    }
  }

  /** This process's view of every key it consumes — sources and page-safe displays, never a
   *  secret value — sent to stream-api for the Credentials page. A `reload: 'restart'` key shows
   *  the value this process took at its first load (what it runs), so a saved change reads as
   *  pending until the restart. */
  function statusReport() {
    const keys = {};
    for (const e of INSTANCE_KEYS) {
      if (!e.packages.includes(SELF)) continue;
      const r = resolveEntry(e);
      const value = applied && e.reload === 'restart' && Object.prototype.hasOwnProperty.call(applied, e.key) ? applied[e.key] : r.value;
      keys[e.key] = { source: r.source, envName: r.envName, display: display(e, value), error: r.error };
    }
    return keys;
  }
  // Another module's part of every report (the AI wrapper's slots, routes and usage). Its
  // `onFailure` runs when the report did not land, so nothing it handed over is lost.
  let reportExtra = null;
  function setReportExtra(fn) { reportExtra = fn; }
  // The AI wrapper's Detect / Test runner, for `config_ai_probe` frames.
  let probeHandler = null;
  function setProbeHandler(fn) { probeHandler = fn; }
  async function report(extra = {}) {
    const more = reportExtra ? reportExtra() : null;
    try { await call('POST', '/config/report', { package: SELF, state: state(), keys: statusReport(), ...(more ? more.extra : {}), ...extra }); }
    catch (e) {
      if (more && more.onFailure) more.onFailure();
      log.warn(`[instance-config] report to stream-api failed: ${e.message}`);
    }
  }

  /** Required install-tier values this process consumes. Returns the list of problems (empty
   *  = fine); index.js exits on any, before anything starts. */
  function bootProblems() {
    const out = [];
    for (const e of INSTANCE_KEYS) {
      if (!e.packages.includes(SELF)) continue;
      const r = resolveInstanceValue(e, envOf(), null);
      if (r.error) out.push(`${e.key}: ${r.error}`);
      else if (e.required && r.value == null) out.push(`${e.key} is required — set ${e.env[0]} in .env`);
    }
    return out;
  }

  async function runTest(key, nonce) {
    const e = instanceEntry(key);
    if (!e || !e.secret || !e.packages.includes(SELF) || !e.test) return;
    const r = resolve(key);
    const result = (await runProviderCheck(e.test, get, fetchImpl)) || { ok: false, code: 'no_check' };
    await report({ tests: [{ key, nonce, result, source: r.source, last4: lastFour(r.value) || null }] });
  }

  async function handleFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'config_changed') {
      const mine = Array.isArray(frame.keys) && frame.keys.some((k) => instanceEntry(k)?.packages.includes(SELF));
      if (!mine) return;
      if (await load()) await report();
    } else if (frame.type === 'config_content_changed') {
      await load();
    } else if (frame.type === 'config_test' && typeof frame.key === 'string' && typeof frame.nonce === 'string') {
      await runTest(frame.key, frame.nonce);
    } else if (frame.type === 'config_ai_probe' && probeHandler && typeof frame.nonce === 'string' && ['detect', 'test', 'embed'].includes(frame.op) && typeof frame.id === 'string') {
      // The AI page's Detect / Test, and the memory panel's embedder probe, run here because this
      // process holds the keys and runs the tasks. The handler answers with a fixed code, ids and
      // numbers; stream-api re-checks it.
      const opts = frame.op === 'embed' ? { model: typeof frame.model === 'string' ? frame.model : '', dimensions: Number.isInteger(frame.dimensions) ? frame.dimensions : undefined } : {};
      const result = await probeHandler(frame.op, frame.id, opts).catch(() => ({ ok: false, code: 'network' }));
      await report({ reply: { nonce: frame.nonce, result } });
    }
  }

  function connect() {
    if (closed) return;
    let url;
    try { url = streamApiWsUrl(envOf()); } catch (e) { log.warn(`[instance-config] socket: ${e.message}`); return scheduleReconnect(); }
    // The bearer secret at upgrade makes this an INTERNAL socket: the only kind stream-api
    // sends control frames to.
    const secret = envOf().STREAM_API_SECRET || '';
    try { ws = new WebSocketImpl(url, secret ? { headers: { Authorization: `Bearer ${secret}` } } : undefined); } catch (e) { log.warn(`[instance-config] socket: ${e.message}`); return scheduleReconnect(); }
    ws.on('open', () => { load().then(() => report()); });
    ws.on('message', (data) => {
      const text = data.toString();
      for (const fn of messageListeners) { try { fn(text); } catch (e) { log.warn(`[instance-config] message listener: ${e.message}`); } }
      // Every chat line rides this socket; only parse what could be ours.
      if (!text.includes('"config_')) return;
      let frame;
      try { frame = JSON.parse(text); } catch { return; }
      handleFrame(frame).catch((e) => log.warn(`[instance-config] frame: ${e.message}`));
    });
    ws.on('close', () => { ws = null; scheduleReconnect(); });
    ws.on('error', () => { /* 'close' follows and reconnects */ });
  }
  function scheduleRetry() {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; load().then((ok) => { if (ok) report(); }); }, RETRY_MS);
    retryTimer.unref?.();
  }
  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
    reconnectTimer.unref?.();
  }

  /** Boot: the first load (bounded), the first report, then the live socket. */
  async function start() {
    const ok = await load();
    const counts = {};
    for (const k of Object.values(statusReport())) counts[k.source] = (counts[k.source] || 0) + 1;
    log.log(`[instance-config] ${ok ? 'loaded' : 'NOT loaded (env + defaults)'} — this process: ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(', ')}`);
    for (const [k, v] of Object.entries(statusReport())) if (v.error) log.error(`[instance-config] ${k}: ${v.error}`);
    connect();
    backstopTimer = setInterval(() => { load().then((fresh) => { if (fresh) report(); }); }, BACKSTOP_MS);
    backstopTimer.unref?.();
    return ok;
  }
  function stop() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (retryTimer) clearTimeout(retryTimer);
    if (backstopTimer) clearInterval(backstopTimer);
    try { ws?.close(); } catch { /* already closed is the state stop() wants */ }
  }

  // Raw text of every frame on the internal socket, for a product module that listens to the
  // live feed (memory's site-message embedder) without opening a socket of its own.
  const messageListeners = new Set();
  function onMessage(fn) { messageListeners.add(fn); return () => messageListeners.delete(fn); }

  return { get, content: contentOf, contentLoaded, onLoad, resolve, load, start, stop, bootProblems, handleFrame, statusReport, state, setReportExtra, setProbeHandler, reportNow: () => report(), onMessage };
}

/** The process singleton every stream-ingest module reads through. */
export const instanceConfig = createInstanceConfig();
