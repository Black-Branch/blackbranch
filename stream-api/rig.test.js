// rig.js — the rig page's server half, on REAL sockets: ws-hub routes /rig to it on
// the same http server, the key is checked at hello, a clip goes out as a signed short-lived link the
// clip route serves, the queue's `done` follows what the page reports, and scenes travel both ways.
// Run: node --test rig.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const WebSocket = require('ws');
const { createWsHub } = require('./ws-hub');
const { createRig } = require('./rig');

const SECRET = 'test-secret-'.padEnd(64, 'x');
const quiet = { log() {}, warn() {} };

function fakeConfig() {
  const values = {};
  const writes = [];
  return {
    values, writes,
    get: (k) => values[k],
    async writeInternal(k, v, by) {
      if (!by) return { status: 400, body: { error: 'updatedBy (who is making this change) is required' } };
      writes.push([k, v, by]);
      if (!values.__pinned) values[k] = v;
      return { status: 200, body: { ok: true } };
    },
  };
}

async function setup(t, { start = true, timing, now } = {}) {
  const config = fakeConfig();
  const rig = createRig({ config, log: quiet, timing, now });
  rig.init({ secret: SECRET });
  if (start) rig.start();
  const app = express();
  app.use(express.json());
  const router = express.Router();
  const calls = { voice: [], sound: [] };
  rig.registerRigRoutes(router, {
    requireSecret: (req, res, next) => next(),
    wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
    speakTest: (clip) => calls.voice.push(clip),
    soundTest: (clip) => calls.sound.push(clip),
    which: () => 'rig',
  });
  app.use(router);
  const server = http.createServer(app);
  const hub = createWsHub({ server });
  hub.routeUpgrade(rig.PATH, rig.handleUpgrade);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => {
    rig.stop();
    for (const ws of hub.wss.clients) ws.terminate();
    hub.wss.close();
    await new Promise((r) => server.close(r));
  });
  return { rig, hub, config, port, calls, base: `http://127.0.0.1:${port}` };
}

/** A page: connects to /rig (offering `key` the way the browser page does), collects frames. */
function page(port, { key = null, pathname = '/rig', headers = {} } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, key == null ? [] : ['rig.v1', `rig-key.${key}`], { headers });
  const frames = [];
  const waiters = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d));
    frames.push(f);
    for (const w of [...waiters]) if (w.match(f)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(f); }
  });
  const next = (type) => {
    const have = frames.find((f) => f.type === type && !f.__seen);
    if (have) { have.__seen = true; return Promise.resolve(have); }
    return new Promise((resolve) => waiters.push({ match: (f) => f.type === type && (f.__seen = true), resolve }));
  };
  const closed = new Promise((resolve) => ws.on('close', (code, why) => resolve({ code, why: String(why) })));
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`))); ws.on('error', () => {}); });
  return { ws, frames, next, closed, opened, send: (f) => ws.send(JSON.stringify(f)) };
}

async function helloed(env, extra = {}, opts = {}) {
  const p = page(env.port, { key: env.rig.key(), ...opts });
  await p.opened;
  assert.equal(p.ws.protocol, 'rig.v1', 'the server answers with the protocol name, never the key');
  await p.next('rig.welcome');
  p.send({ type: 'rig.hello', level: 4, scene: 'Main', scenes: ['Main', 'Break'], ...extra });
  await new Promise((r) => setTimeout(r, 30));
  return p;
}

function clipFile(bytes = Buffer.from('ID3fake-mp3-bytes')) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-test-')), 'clip.mp3');
  fs.writeFileSync(f, bytes);
  return f;
}

test('off: /rig is refused with 404 before any socket, and the broadcast socket is untouched', { timeout: 10_000 }, async (t) => {
  const env = await setup(t, { start: false });
  await assert.rejects(page(env.port).opened, /HTTP 404/);
  const viewer = page(env.port, { pathname: '/' });
  await viewer.opened; // every other path is still the broadcast socket
  viewer.ws.close();
});

test('the key: wrong or missing is refused with 401 at the upgrade (no socket); the right one is welcomed; it is derived, stable, and per secret', { timeout: 10_000 }, async (t) => {
  const env = await setup(t);
  const k = env.rig.key();
  assert.match(k, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(env.rig.key(), k, 'stable while the generation is unchanged');
  const other = createRig({ config: fakeConfig(), log: quiet });
  other.init({ secret: 'another-secret' });
  assert.notEqual(other.key(), k, 'another install (another secret) has another key');
  other.stop();

  await assert.rejects(page(env.port, { key: 'nope' }).opened, /HTTP 401/);
  await assert.rejects(page(env.port).opened, /HTTP 401/, 'no key offered');
  assert.equal(env.rig.status().connected, 0, 'a refused upgrade leaves no page behind');

  const good = await helloed(env);
  assert.equal(env.rig.status().connected, 1);
  assert.equal(env.rig.status().pages[0].level, 4);
  good.ws.close();
});

test('two separate pools: viewers at their cap do not keep the rig page out; keyless and over-cap rig upgrades never touch the viewers', { timeout: 15_000 }, async (t) => {
  const prev = process.env.MAX_WS_CLIENTS;
  process.env.MAX_WS_CLIENTS = '3'; // read by createWsHub
  const env = await setup(t);
  if (prev === undefined) delete process.env.MAX_WS_CLIENTS; else process.env.MAX_WS_CLIENTS = prev;
  const viewers = [];
  for (let i = 0; i < 3; i++) { const v = page(env.port, { pathname: '/' }); await v.opened; viewers.push(v); }
  await assert.rejects(page(env.port, { pathname: '/' }).opened, /HTTP 503/, 'the viewer pool is full');
  const p = await helloed(env);
  assert.equal(env.rig.status().connected, 1, 'the rig page still connects with the viewer pool full');
  // A flood of keyless upgrades: each refused before a socket exists — no rig socket, no viewer slot.
  for (let i = 0; i < 40; i++) await assert.rejects(page(env.port, { key: 'flood' }).opened, /HTTP 401/);
  assert.equal(env.rig.status().connected, 1);
  assert.equal(env.hub.wss.clients.size, 3, 'rig upgrades never count against the viewers');
  // Per source address: four pages from one address, the fifth refused; another address still gets in.
  const more = [];
  for (let i = 0; i < 3; i++) more.push(await helloed(env));
  await assert.rejects(page(env.port, { key: env.rig.key() }).opened, /HTTP 429/);
  const elsewhere = await helloed(env, {}, { headers: { 'CF-Connecting-IP': '198.51.100.7' } });
  assert.equal(env.rig.status().connected, 5);
  // In all: eight pages.
  const far = [];
  for (let i = 0; i < 3; i++) far.push(await helloed(env, {}, { headers: { 'CF-Connecting-IP': `198.51.100.${10 + i}` } }));
  await assert.rejects(page(env.port, { key: env.rig.key(), headers: { 'CF-Connecting-IP': '198.51.100.99' } }).opened, /HTTP 503/);
  assert.equal(env.rig.status().connected, 8);
  assert.equal(env.hub.wss.clients.size, 3, 'eight rig pages took no viewer slot');
  for (const x of [p, ...more, elsewhere, ...far, ...viewers]) x.ws.close();
});

test('a clip: a rig.play frame with a signed path; the route serves the bytes; a changed or expired link is 404', { timeout: 10_000 }, async (t) => {
  let clock = 1_000_000;
  const env = await setup(t, { now: () => clock });
  const p = await helloed(env);
  const bytes = Buffer.from('ID3 pretend mp3 audio');
  const played = env.rig.play(clipFile(bytes), { kind: 'tts' });
  assert.ok(played, 'a connected page takes the clip');
  const f = await p.next('rig.play');
  assert.equal(f.kind, 'tts');
  assert.match(f.url, /^\/rig\/clip\/[0-9a-f]{32}\?exp=\d+&sig=[A-Za-z0-9_-]{43}$/);
  const res = await fetch(env.base + f.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  const tampered = f.url.replace(/sig=./, (m) => (m.endsWith('A') ? 'sig=B' : 'sig=A'));
  assert.equal((await fetch(env.base + tampered)).status, 404);
  const later = f.url.replace(/exp=(\d+)/, (_, n) => `exp=${Number(n) + 1000}`);
  assert.equal((await fetch(env.base + later)).status, 404, 'a stretched expiry breaks the signature');
  clock += 120_001;
  assert.equal((await fetch(env.base + f.url)).status, 404, 'expired after two minutes');
  p.send({ type: 'rig.ended', id: f.id });
  await played.done;
  p.ws.close();
});

test('done follows the page: ended resolves it; a page that never starts it is given up on; a page that leaves releases it', { timeout: 10_000 }, async (t) => {
  const env = await setup(t, { timing: { startWaitMs: 80 } });
  const p = await helloed(env);
  const a = env.rig.play(clipFile());
  const fa = await p.next('rig.play');
  p.send({ type: 'rig.started', id: fa.id, durationMs: 60_000 });
  let doneA = false;
  a.done.then(() => { doneA = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(doneA, false, 'started and not ended: still playing (past the start wait)');
  p.send({ type: 'rig.ended', id: fa.id });
  await a.done;

  const b = env.rig.play(clipFile());
  await p.next('rig.play');
  const t0 = Date.now();
  await b.done; // never started → the start wait gives up
  assert.ok(Date.now() - t0 < 1000);

  const c = env.rig.play(clipFile());
  const fc = await p.next('rig.play');
  p.send({ type: 'rig.started', id: fc.id, durationMs: 60_000 }); // playing: only the page leaving can end it now
  await new Promise((r) => setTimeout(r, 30));
  const t1 = Date.now();
  p.ws.close();
  await c.done;
  assert.ok(Date.now() - t1 < 2000, 'released when the page left, not at the 60 s backstop');
  assert.equal(env.rig.play(clipFile()), null, 'no page connected: the sink falls through');
});

test('kill sends rig.stop and resolves at once', { timeout: 10_000 }, async (t) => {
  const env = await setup(t);
  const p = await helloed(env);
  const a = env.rig.play(clipFile(), { kind: 'sound' });
  const f = await p.next('rig.play');
  assert.equal(f.kind, 'sound');
  a.kill();
  await a.done;
  assert.equal((await p.next('rig.stop')).id, f.id);
  p.ws.close();
});

test('the avatar latch and scenes: speaking reaches the page; its scene reports reach the callbacks; switching needs Advanced', { timeout: 10_000 }, async (t) => {
  const env = await setup(t);
  const seen = [];
  env.rig.onSceneChange((s) => seen.push(s));
  const p = await helloed(env);
  assert.deepEqual(seen, ['Main'], 'the hello carries the scene on air');
  env.rig.setSpeaking(true);
  assert.equal((await p.next('rig.speaking')).on, true);
  p.send({ type: 'rig.scene', name: 'Break' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ['Main', 'Break']);
  assert.equal(env.rig.currentScene(), 'Break');

  assert.equal(env.rig.switchScene('Nope').code, 'unknown_scene');
  const r = await fetch(`${env.base}/rig/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Main' }) });
  assert.deepEqual(await r.json(), { ok: true, code: 'sent' });
  assert.equal((await p.next('rig.setScene')).name, 'Main');
  p.ws.close();

  const low = await helloed(env, { level: 2 });
  assert.equal(env.rig.switchScene('Main').code, 'no_permission');
  low.ws.close();
  await low.closed;
  assert.equal(env.rig.switchScene('Main').code, 'not_connected');
});

test('regenerate: a new key, every page on the old one closed; a pinned generation says so', { timeout: 10_000 }, async (t) => {
  const env = await setup(t);
  const old = env.rig.key();
  const p = await helloed(env);
  const r = await fetch(`${env.base}/rig/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedBy: '@admin:site.test' }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.notEqual(body.key, old);
  assert.deepEqual(env.config.writes, [['obs.rigKeyVersion', 1, '@admin:site.test']]);
  assert.equal((await p.closed).code, 4401);

  env.config.values.__pinned = true;
  const pinned = await fetch(`${env.base}/rig/key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updatedBy: '@admin:site.test' }) });
  assert.equal(pinned.status, 409);
  assert.match((await pinned.json()).error, /OBS_RIG_KEY_VERSION/);
});

test('status (with the key) and the test buttons: a WAV made here goes to the voice or the sound path', { timeout: 10_000 }, async (t) => {
  const env = await setup(t);
  const s = await (await fetch(`${env.base}/rig/status`)).json();
  assert.equal(s.on, true);
  assert.equal(s.key, env.rig.key());
  assert.equal(s.connected, 0);
  assert.equal(s.sink, 'rig');
  for (const what of ['voice', 'sound']) {
    const r = await fetch(`${env.base}/rig/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }) });
    assert.equal(r.status, 200);
    const clip = env.calls[what][0];
    assert.ok(Buffer.isBuffer(clip) && clip.toString('latin1', 0, 4) === 'RIFF' && clip.toString('latin1', 8, 12) === 'WAVE', `${what}: a WAV`);
    assert.ok(clip.length > 10_000, `${what}: audible length`);
  }
  assert.equal((await fetch(`${env.base}/rig/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  // a WAV clip is served as audio/wav
  const p = await helloed(env);
  const wav = env.calls.voice[0];
  env.rig.play(clipFile(wav));
  const f = await p.next('rig.play');
  assert.equal((await fetch(env.base + f.url)).headers.get('content-type'), 'audio/wav');
  p.ws.close();
});

// Vacuity anchor: the routes this file drives are the ones rig.js registers.
test('rig.js registers exactly the five routes the obs module owns', { timeout: 10_000 }, () => {
  const src = fs.readFileSync(path.join(__dirname, 'rig.js'), 'utf8');
  const routes = [...src.matchAll(/app\.(get|post)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), ['GET /rig/clip/:id', 'GET /rig/status', 'POST /rig/key', 'POST /rig/scene', 'POST /rig/test']);
  assert.match(src, /module\.exports = \{ rig, createRig \};\s*$/);
});
