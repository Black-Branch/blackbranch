// A reconnect asks only for what changed while it was away.
//
// The defect: every reconnect — a phone between cells, a tab waking, a wifi blip — was sent the
// whole 200-line `history` frame again (~98 KB measured on the throwaway pair with 200 short
// lines). The client already holds all but the last few of those lines.
//
// The contract (plan 2026-10-24 Task 18): every buffered entry carries a `seq`, bumped on insert
// AND on every later change (redaction, a vote, a boost); the hub has a per-boot `epoch`; a
// socket that connects with `?since=<seq>&epoch=<epoch>` gets a `history` frame with
// `delta: true` holding exactly the entries whose seq is past `since` — a line deleted while it
// was away arrives as its redacted envelope. Anything the hub cannot vouch for (another boot's
// epoch, a since older than what the buffer still holds, a since from the future, garbage) gets
// the full frame, as before. One REAL server and real sockets per case.
//
// Run: node --test ws-history-delta.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { createWsHub } = require('./ws-hub');

const INTERNAL = 'Bearer test-secret';

async function startHub() {
  const server = http.createServer();
  const hub = createWsHub({ server, isInternalUpgrade: (h) => h.authorization === INTERNAL });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `ws://127.0.0.1:${server.address().port}`;
  const stop = async () => { hub.wss.close(); await new Promise((r) => server.close(r)); };
  return { hub, base, stop };
}

/** Connect, collect the frames sent at connect time, close. Returns parsed frames after `hello`. */
function connectFrames(url, headers = {}, ms = 150) {
  return new Promise((resolve, reject) => {
    const got = [];
    const ws = new WebSocket(url, { headers });
    ws.on('message', (d) => got.push(String(d)));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => { ws.close(); resolve(got.slice(1)); }, ms));
  });
}
const historyOf = async (url, headers) => (await connectFrames(url, headers)).map((s) => JSON.parse(s)).find((f) => f.type === 'history');
const resume = (base, since, epoch) => `${base}/?since=${since}&epoch=${epoch}`;

function line(id, extra = {}) {
  return { type: 'message', platform: 'twitch', id, username: 'casey', message: `line ${id}`, ...extra };
}

test('the full frame names the boot and the newest seq; every entry carries its own seq', async () => {
  const { hub, base, stop } = await startHub();
  try {
    hub.bufferPush(line(1)); hub.bufferPush(line(2));
    const h = await historyOf(base);
    assert.equal(h.delta, undefined, 'a plain connect is the full frame, as before');
    assert.equal(typeof h.epoch, 'string');
    assert.ok(h.epoch.length >= 8);
    assert.equal(h.seq, 2);
    assert.deepEqual(h.messages.map((m) => m.seq), [1, 2]);
  } finally { await stop(); }
});

test('delta holds only seq > since', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 5; i++) hub.bufferPush(line(i));
    const { epoch, seq } = await historyOf(base);
    hub.bufferPush(line(6));
    hub.bufferPush(line(7));
    const d = await historyOf(resume(base, seq, epoch));
    assert.equal(d.delta, true);
    assert.equal(d.epoch, epoch);
    assert.equal(d.seq, 7);
    assert.deepEqual(d.messages.map((m) => m.id), [6, 7], 'only the two lines that arrived while away');
  } finally { await stop(); }
});

test('a reconnect with nothing new gets an empty delta, not the whole buffer', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 3; i++) hub.bufferPush(line(i));
    const { epoch, seq } = await historyOf(base);
    const d = await historyOf(resume(base, seq, epoch));
    assert.equal(d.delta, true);
    assert.deepEqual(d.messages, []);
    assert.equal(d.seq, seq);
  } finally { await stop(); }
});

test('a message deleted while away arrives as its envelope', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 4; i++) hub.bufferPush(line(i, { emoteUrl: 'https://cdn.example/e.png', emoteName: 'Kappa' }));
    const { epoch, seq } = await historyOf(base);
    hub.redactBuffered(hub.msgBuffer.find((b) => b.id === 2));
    const d = await historyOf(resume(base, seq, epoch));
    assert.equal(d.delta, true);
    assert.equal(d.messages.length, 1, 'only the changed line');
    const env = d.messages[0];
    assert.equal(env.id, 2);
    assert.equal(env.platform, 'twitch');
    assert.equal(env.deleted, true);
    assert.equal(env.message, '', 'the envelope carries no text');
    assert.equal(env.emoteUrl, null);
    assert.equal(env.emoteName, null);
  } finally { await stop(); }
});

test('a vote changes the line: its seq moves and the cached full frame shows the new score', async () => {
  const { hub, base, stop } = await startHub();
  try {
    hub.bufferPush(line(1)); hub.bufferPush(line(2));
    const first = await historyOf(base);
    const b = hub.msgBuffer.find((x) => x.id === 1);
    b.score = 3;
    hub.touchBuffered(b);
    const full = await historyOf(base);
    assert.equal(full.messages.find((m) => m.id === 1).score, 3, 'the cached full frame still serves the old score');
    const d = await historyOf(resume(base, first.seq, first.epoch));
    assert.deepEqual(d.messages.map((m) => [m.id, m.score]), [[1, 3]]);
  } finally { await stop(); }
});

test('unknown epoch → full', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 3; i++) hub.bufferPush(line(i));
    const { seq } = await historyOf(base);
    const h = await historyOf(resume(base, seq, 'deadbeefdeadbeef'));
    assert.equal(h.delta, undefined);
    assert.deepEqual(h.messages.map((m) => m.id), [1, 2, 3]);
  } finally { await stop(); }
});

test('since older than the buffer → full', async () => {
  const { hub, base, stop } = await startHub();
  try {
    hub.bufferPush(line(1));
    const { epoch, seq } = await historyOf(base);
    // 201 more lines push out line 1 AND line 2 — a line the client never saw.
    for (let i = 2; i <= 202; i++) hub.bufferPush(line(i));
    assert.equal(hub.msgBuffer[0].id, 3);
    const h = await historyOf(resume(base, seq, epoch));
    assert.equal(h.delta, undefined, 'a line the client never saw has left the buffer — only the full frame is honest');
    assert.equal(h.messages.length, 200);
    // One line short of that: everything the client lacks is still held, so a delta is exact.
    const { epoch: e2, seq: s2 } = await historyOf(base);
    hub.bufferPush(line(203));
    const d = await historyOf(resume(base, s2, e2));
    assert.equal(d.delta, true);
    assert.deepEqual(d.messages.map((m) => m.id), [203]);
  } finally { await stop(); }
});

test('a line deleted and then pushed out of the buffer while away → full, never a delta that misses the deletion', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 200; i++) hub.bufferPush(line(i));
    const { epoch, seq } = await historyOf(base);
    hub.redactBuffered(hub.msgBuffer[0]); // line 1, the oldest, deleted: its seq is now the newest
    hub.bufferPush(line(201));            // …and line 1 leaves the buffer with its envelope
    const h = await historyOf(resume(base, seq, epoch));
    assert.equal(h.delta, undefined, 'the envelope is gone, so a delta would leave the deleted line on the client');
  } finally { await stop(); }
});

test('a since from the future, or garbage, → full', async () => {
  const { hub, base, stop } = await startHub();
  try {
    for (let i = 1; i <= 3; i++) hub.bufferPush(line(i));
    const { epoch } = await historyOf(base);
    for (const since of ['999', '-1', 'abc', '1.5', '']) {
      const h = await historyOf(resume(base, since, epoch));
      assert.equal(h.delta, undefined, `since=${JSON.stringify(since)} was answered with a delta`);
      assert.equal(h.messages.length, 3);
    }
  } finally { await stop(); }
});

test('restart: a reconnect after stream-api restarts (a new epoch) gets the full history', async () => {
  const a = await startHub();
  let seen;
  try {
    for (let i = 1; i <= 3; i++) a.hub.bufferPush(line(i));
    seen = await historyOf(a.base);
  } finally { await a.stop(); }
  // The new process: same code, a fresh buffer that happens to reach the same seq.
  const b = await startHub();
  try {
    for (let i = 11; i <= 14; i++) b.hub.bufferPush(line(i));
    const h = await historyOf(resume(b.base, seen.seq, seen.epoch));
    assert.notEqual(h.epoch, seen.epoch, 'each boot names itself anew');
    assert.equal(h.delta, undefined, 'the old boot\'s position means nothing to the new one');
    assert.deepEqual(h.messages.map((m) => m.id), [11, 12, 13, 14]);
  } finally { await b.stop(); }
});

test('retry: the same resume asked twice gets the same delta (asking consumes nothing)', async () => {
  const { hub, base, stop } = await startHub();
  try {
    hub.bufferPush(line(1));
    const { epoch, seq } = await historyOf(base);
    hub.bufferPush(line(2));
    const once = await historyOf(resume(base, seq, epoch));
    const twice = await historyOf(resume(base, seq, epoch));
    assert.deepEqual(twice, once);
    assert.deepEqual(once.messages.map((m) => m.id), [2]);
  } finally { await stop(); }
});

test('a live line carries its seq, so a client can resume from the last line it saw', async () => {
  const { hub, base, stop } = await startHub();
  try {
    const got = [];
    const ws = new WebSocket(base);
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 50));
    const msg = line(1);
    hub.bufferPush(msg);
    hub.broadcast(msg);
    await new Promise((r) => setTimeout(r, 80));
    ws.close();
    assert.equal(got.find((f) => f.type === 'message').seq, 1);
  } finally { await stop(); }
});

test('a delta on a public socket never carries a canonical id; the internal socket still gets it', async () => {
  const { hub, base, stop } = await startHub();
  try {
    hub.bufferPush(line(1, { canonicalId: '0a1b2c3d4e5f', publicId: 'pAAAA' }));
    const { epoch, seq } = await historyOf(base);
    hub.bufferPush(line(2, { canonicalId: '0a1b2c3d4e5f', publicId: 'pAAAA', reply: { canonicalId: '0a1b2c3d4e5f' } }));
    const raw = (await connectFrames(resume(base, seq, epoch))).find((s) => s.includes('"history"'));
    assert.ok(raw.includes('"delta":true'), 'expected the delta frame');
    assert.ok(!raw.includes('canonicalId') && !raw.includes('0a1b2c3d4e5f'), `public delta carried a canonical: ${raw}`);
    assert.ok(raw.includes('pAAAA'));
    const int = await historyOf(resume(base, seq, epoch), { Authorization: INTERNAL });
    assert.equal(int.delta, true);
    assert.equal(int.messages[0].canonicalId, '0a1b2c3d4e5f');
  } finally { await stop(); }
});

test('the full frame is still serialized once per change, however many sockets connect', async () => {
  const { hub, base, stop } = await startHub();
  const orig = JSON.stringify;
  let fullStringifies = 0;
  JSON.stringify = function (v, ...rest) {
    if (v && v.type === 'history' && !v.delta) fullStringifies++;
    return orig.call(this, v, ...rest);
  };
  try {
    for (let i = 1; i <= 3; i++) hub.bufferPush(line(i));
    await Promise.all([historyOf(base), historyOf(base), historyOf(base), historyOf(base)]);
    assert.equal(fullStringifies, 1, 'four public connects, one change: one serialization');
    hub.bufferPush(line(4));
    await Promise.all([historyOf(base), historyOf(base)]);
    assert.equal(fullStringifies, 2, 'one more change, one more serialization');
  } finally { JSON.stringify = orig; await stop(); }
});

test('a vote through the real /chat/vote route reaches a resuming client', async () => {
  const { registerChatMod } = require('./chat-mod');
  const { hub, base, stop } = await startHub();
  try {
    const routes = {};
    registerChatMod({ post: (path, ...h) => { routes[path] = h[h.length - 1]; } }, {
      pool: { query: async () => ({ rows: [] }) }, msgBuffer: hub.msgBuffer, broadcast: hub.broadcast,
      redactBuffered: hub.redactBuffered, touchBuffered: hub.touchBuffered,
      requireInternal: (q, r, n) => n(), wrap: (fn) => fn,
    });
    hub.bufferPush(line(1)); hub.bufferPush(line(2));
    const { epoch, seq } = await historyOf(base);
    const res = { status() { return this; }, json(b) { this.body = b; return this; } };
    await routes['/chat/vote']({ body: { platform: 'twitch', messageId: 1, score: 5 } }, res);
    assert.deepEqual(res.body, { ok: true });
    const d = await historyOf(resume(base, seq, epoch));
    assert.deepEqual(d.messages.map((m) => [m.id, m.score]), [[1, 5]]);
  } finally { await stop(); }
});

test('an old position gets the cached full frame, serialized once however many sockets ask', async () => {
  const { hub, base, stop } = await startHub();
  const orig = JSON.stringify;
  let serialized = 0;
  JSON.stringify = function (v, ...rest) {
    if (v && v.type === 'history') serialized++;
    return orig.call(this, v, ...rest);
  };
  try {
    hub.bufferPush(line(1));
    const { epoch, seq } = await historyOf(base);
    for (let i = 2; i <= 150; i++) hub.bufferPush(line(i)); // 149 changes: past the delta cap, all still held
    serialized = 0;
    const got = await Promise.all([1, 2, 3, 4, 5].map(() => historyOf(resume(base, seq, epoch))));
    for (const h of got) {
      assert.equal(h.delta, undefined, 'a far-back resume is answered with the full frame');
      assert.equal(h.messages.length, 150);
    }
    assert.equal(serialized, 1, 'five far-back resumes, one buffer state: the cached frame, serialized once');
    // Up to the cap a delta is still exact (40 changes back).
    const near = await historyOf(base);
    for (let i = 151; i <= 190; i++) hub.bufferPush(line(i));
    const d = await historyOf(resume(base, near.seq, near.epoch));
    assert.equal(d.delta, true);
    assert.equal(d.messages.length, 40);
    hub.bufferPush(line(191));
    assert.equal((await historyOf(resume(base, near.seq, near.epoch))).delta, undefined, '41 back is past the cap');
  } finally { JSON.stringify = orig; await stop(); }
});

// ── Wiring: the composition root hands the hub's touchBuffered to the vote route ──
// Positive matches only (a short read goes red on its own).
test('index.js wires touchBuffered from the hub into registerChatMod', () => {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.match(src, /const \{[^}]*\btouchBuffered\b[^}]*\} = createWsHub\(/);
  assert.match(src, /registerChatMod\(app, \{[^}]*\btouchBuffered\b[^}]*\}\)/);
});
