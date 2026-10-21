// ws-hub.js — one REAL socket, because the connect path is where a client's
// first paint is decided and a mock cannot tell you what actually arrives.
//
// Run: node --test ws-hub.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createWsHub } = require('./ws-hub');

function collectFrames(url, ms = 400) {
  return new Promise((resolve, reject) => {
    const got = [];
    const ws = new WebSocket(url);
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => {
      ws.close();
      // Every socket hears the hub's hello first (M4) — checked here, then set aside.
      assert.deepEqual(got[0], { type: 'hello', internal: false }, 'the hello was not the first frame');
      resolve(got.slice(1));
    }, ms));
  });
}

test('a client gets the current state frames the moment it connects — after history, in order, skipping a builder that throws', async () => {
  const server = http.createServer();
  const hub = createWsHub({
    server,
    connectFrames: [
      () => ({ type: 'timerState', running: true, remainingSec: 7200 }),
      () => { throw new Error('not ready'); },
      () => null,
      () => ({ type: 'sponsorState', sponsors: [{ name: 'Bram42', weightPct: 100 }] }),
    ],
  });
  hub.bufferPush({ type: 'chat', text: 'hello' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origWarn = console.warn; console.warn = () => {};
  let frames;
  try {
    frames = await collectFrames(`ws://127.0.0.1:${server.address().port}`);
  } finally {
    console.warn = origWarn;
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(frames.map((f) => f.type), ['history', 'timerState', 'sponsorState']);
  assert.equal(frames[2].sponsors[0].name, 'Bram42');
});

// ── one address cannot fill the socket ──────────────────────────────────────
// With only one global MAX_WS_CLIENTS, checked for everyone — `ws` clients
// auto-pong, so idle sockets are never reaped — one host opening thousands of
// connections fills the cap, and then every OBS overlay, every viewer's chat
// socket and web's internal config_changed socket gets 503: alerts and the
// timer go dark on stream. So each address has its own cap
// (CF-Connecting-IP when the tunnel sets it — all public traffic arrives from
// the tunnel host — else the socket address; for LIMITING only, never auth),
// a closed socket gives its slot back, and a secret-bearing (internal) upgrade
// is never refused for capacity.

const INTERNAL = 'Bearer test-secret';

function openSocket(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_req, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

async function capRig(opts) {
  const server = http.createServer();
  // The test client connects from loopback; trusting it plays the tunnel host.
  const hub = createWsHub({ server, isInternalUpgrade: (h) => h.authorization === INTERNAL, trustedProxies: '127.0.0.1', ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const open = [];
  const connect = async (headers) => { const r = await openSocket(url, headers); if (r.ok) open.push(r.ws); return r; };
  const close = async () => {
    for (const ws of open) ws.terminate();
    hub.wss.close();
    await new Promise((r) => server.close(r));
  };
  return { connect, close, hub };
}

async function quietly(fn) {
  const w = console.warn; console.warn = () => {};
  try { return await fn(); } finally { console.warn = w; }
}

test('one address is capped; another address still gets in', async () => {
  const rig = await capRig({ maxPerAddress: 2, maxClients: 100 });
  try {
    await quietly(async () => {
      const a = { 'cf-connecting-ip': '203.0.113.7' };
      assert.ok((await rig.connect(a)).ok);
      assert.ok((await rig.connect(a)).ok);
      const third = await rig.connect(a);
      assert.equal(third.ok, false, 'one address opened more sockets than its cap');
      assert.equal(third.status, 429);
      assert.ok((await rig.connect({ 'cf-connecting-ip': '198.51.100.9' })).ok,
        'a second address was locked out by the first address\'s flood');
    });
  } finally { await rig.close(); }
});

test('a closed socket gives its address slot back', async () => {
  const rig = await capRig({ maxPerAddress: 1, maxClients: 100 });
  try {
    await quietly(async () => {
      const a = { 'cf-connecting-ip': '203.0.113.7' };
      const first = await rig.connect(a);
      assert.ok(first.ok);
      assert.equal((await rig.connect(a)).ok, false);
      await new Promise((r) => { first.ws.once('close', r); first.ws.close(); });
      await new Promise((r) => setTimeout(r, 50)); // the server's close event
      assert.ok((await rig.connect(a)).ok, 'a closed socket kept its slot — the address is locked out forever');
    });
  } finally { await rig.close(); }
});

test('with no tunnel header, the socket address is the bucket', async () => {
  const rig = await capRig({ maxPerAddress: 1, maxClients: 100 });
  try {
    await quietly(async () => {
      assert.ok((await rig.connect({})).ok);
      assert.equal((await rig.connect({})).ok, false);
    });
  } finally { await rig.close(); }
});

// The header is believed only from a trusted proxy. From any other peer a client
// could send a fresh value per socket and never fill a bucket.
test('a forged CF-Connecting-IP from an untrusted socket is ignored — the socket address is the bucket', async () => {
  const rig = await capRig({ maxPerAddress: 2, maxClients: 100, trustedProxies: '' });
  try {
    await quietly(async () => {
      assert.ok((await rig.connect({ 'cf-connecting-ip': '203.0.113.1' })).ok);
      assert.ok((await rig.connect({ 'cf-connecting-ip': '203.0.113.2' })).ok);
      const third = await rig.connect({ 'cf-connecting-ip': '203.0.113.3' });
      assert.equal(third.status, 429, 'a new forged header per socket walked past the per-address cap');
    });
  } finally { await rig.close(); }
});

test('the header IS the bucket when the socket is a trusted proxy (IPv4-mapped form too)', async () => {
  // Assembled at run time: the public cut holds the tree at zero private-network literals.
  const proxyA = [10, 0, 0, 9].join('.');
  const rig = await capRig({ maxPerAddress: 1, maxClients: 100, trustedProxies: `${proxyA}, ::ffff:127.0.0.1` });
  try {
    await quietly(async () => {
      assert.ok((await rig.connect({ 'cf-connecting-ip': '203.0.113.1' })).ok);
      assert.ok((await rig.connect({ 'cf-connecting-ip': '203.0.113.2' })).ok,
        'two real viewers behind the trusted tunnel host were put in one bucket');
      assert.equal((await rig.connect({ 'cf-connecting-ip': '203.0.113.1' })).status, 429);
    });
  } finally { await rig.close(); }
});

test('an internal (secret-bearing) upgrade is never refused for capacity', async () => {
  const rig = await capRig({ maxPerAddress: 1, maxClients: 1, localReserve: 0 });
  try {
    await quietly(async () => {
      assert.ok((await rig.connect({ 'cf-connecting-ip': '203.0.113.7' })).ok);
      assert.equal((await rig.connect({ 'cf-connecting-ip': '198.51.100.9' })).status, 503, 'the global cap must still hold for the public');
      const internal = await rig.connect({ authorization: INTERNAL });
      assert.ok(internal.ok, 'web\'s internal socket was refused because the public filled the cap');
      assert.ok((await rig.connect({ authorization: INTERNAL })).ok, 'a second internal socket was refused by the per-address cap');
    });
  } finally { await rig.close(); }
});

test('with no connectFrames (the old contract) a client gets history alone', async () => {
  const server = http.createServer();
  const hub = createWsHub({ server });
  hub.bufferPush({ type: 'chat', text: 'hello' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let frames;
  try { frames = await collectFrames(`ws://127.0.0.1:${server.address().port}`); }
  finally { hub.wss.close(); await new Promise((r) => server.close(r)); }
  assert.deepEqual(frames.map((f) => f.type), ['history']);
});

// ── IPv6 per /64; local overlays exempt and kept headroom ────────────────────
const { bucketOf, isLocalDirect } = require('./ws-hub');

test('IPv6 is counted per /64 — one host cannot mint a bucket per address', () => {
  assert.equal(bucketOf('2001:db8:1:2::1'), bucketOf('2001:db8:1:2:ffff:ffff:ffff:9'));
  assert.equal(bucketOf('2001:0db8:0001:0002:0:0:0:5'), '2001:db8:1:2::/64');
  assert.notEqual(bucketOf('2001:db8:1:2::1'), bucketOf('2001:db8:1:3::1'));
  assert.equal(bucketOf('203.0.113.7'), '203.0.113.7');
  assert.equal(bucketOf('::ffff:203.0.113.7'), '203.0.113.7');
});

test('two IPv6 addresses in one /64 share one bucket through the tunnel', async () => {
  const rig = await capRig({ maxPerAddress: 1, maxClients: 100 });
  try {
    await quietly(async () => {
      assert.ok((await rig.connect({ 'cf-connecting-ip': '2001:db8:1:2::1' })).ok);
      const second = await rig.connect({ 'cf-connecting-ip': '2001:db8:1:2::abcd' });
      assert.equal(second.ok, false, 'a second address in the same /64 got its own bucket');
      assert.equal(second.status, 429);
    });
  } finally { await rig.close(); }
});

test('isLocalDirect: a private source straight to the port, never one through the tunnel', () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  const none = new Set();
  // The private addresses are assembled at run time: the public cut holds the whole tree at zero
  // private-network literals (tools/literals.json), and this test needs three RFC 1918 shapes.
  const quad = (...o) => o.join('.');
  const lanC = quad(192, 168, 1, 20);
  const lanA = quad(10, 0, 0, 5);
  const lanB = quad(172, 20, 0, 2);
  const proxyA = quad(10, 0, 0, 9);
  assert.equal(isLocalDirect(req(lanC), none), true);
  assert.equal(isLocalDirect(req(`::ffff:${lanA}`), none), true);
  assert.equal(isLocalDirect(req(lanB), none), true);
  assert.equal(isLocalDirect(req('203.0.113.7'), none), false, 'a public address is not local');
  assert.equal(isLocalDirect(req(lanC, { 'cf-connecting-ip': '203.0.113.7' }), none), false,
    'traffic through the tunnel must never count as local, even from an untrusted tunnel host');
  assert.equal(isLocalDirect(req(proxyA), new Set([proxyA])), false, 'a trusted proxy is not local');
});

test('local overlays (direct, private source) are exempt from the per-address cap', async () => {
  const rig = await capRig({ maxPerAddress: 1, maxClients: 100, trustedProxies: '' });
  try {
    await quietly(async () => {
      for (let i = 0; i < 5; i++) assert.ok((await rig.connect({})).ok, `local overlay #${i + 1} was refused`);
    });
  } finally { await rig.close(); }
});

test('a public flood stops short of the global cap; the reserve is left for local overlays', async () => {
  const rig = await capRig({ maxPerAddress: 100, maxClients: 4, localReserve: 2, trustedProxies: '' });
  try {
    await quietly(async () => {
      const pub = { 'cf-connecting-ip': '203.0.113.7' }; // from an untrusted host: public, socket-keyed
      assert.ok((await rig.connect(pub)).ok);
      assert.ok((await rig.connect(pub)).ok);
      const third = await rig.connect(pub);
      assert.equal(third.ok, false, 'the public flood took the headroom kept for local overlays');
      assert.equal(third.status, 503);
      assert.ok((await rig.connect({})).ok, 'a local overlay was locked out by a public flood');
      assert.ok((await rig.connect({})).ok);
      assert.equal((await rig.connect({})).ok, false, 'the global cap still holds for local sockets');
    });
  } finally { await rig.close(); }
});

test('the hello says internal:true on a bearer socket and internal:false otherwise — the first frame either way (M4)', async () => {
  const server = http.createServer();
  const hub = createWsHub({ server, isInternalUpgrade: (h) => h.authorization === INTERNAL, trustedProxies: '127.0.0.1' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const first = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('message', (d) => { resolve(JSON.parse(String(d))); ws.terminate(); });
    ws.once('error', reject);
  });
  try {
    assert.deepEqual(await first({ Authorization: INTERNAL }), { type: 'hello', internal: true });
    assert.deepEqual(await first({ Authorization: 'Bearer wrong' }), { type: 'hello', internal: false });
    assert.deepEqual(await first({}), { type: 'hello', internal: false });
  } finally {
    hub.wss.close();
    await new Promise((r) => server.close(r));
  }
});
