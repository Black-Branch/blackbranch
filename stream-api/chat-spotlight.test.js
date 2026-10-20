// POST /chat/spotlight — the streamer's "highlight": the ONE message being answered on
// stream, shown to everyone with the highlight-card look.
// Driven through the REAL register function against a fake app, the same way
// sponsors-route.test.js drives its route. The state is in-memory only (a
// click while talking; nothing to keep across a restart) and replays to a
// connecting client through ws-hub's connectFrames, so a reloading OBS source
// or a late-opening tab paints it at once — and a reconnecting one is told when
// there is nothing to paint, so a cleared pick cannot linger on stream.
//
// Run: node --test chat-spotlight.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { registerChatMod } = require('./chat-mod');
const { NATIVE_PLATFORM } = require('./native-platform');

function fakeApp() {
  const routes = {};
  return { routes, post: (path, ...h) => { routes[path] = { middleware: h.slice(0, -1), handler: h[h.length - 1] }; } };
}
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function harness() {
  const sent = [];
  const app = fakeApp();
  const requireInternal = (req, res, next) => next();
  const chatMod = registerChatMod(app, {
    pool: { query: async () => { throw new Error('no db in this test'); } },
    msgBuffer: [], broadcast: (f) => sent.push(f), redactBuffered: () => {},
    requireInternal, wrap: (fn) => fn,
  });
  const route = app.routes['/chat/spotlight'];
  const post = async (body) => { const res = fakeRes(); await route.handler({ body }, res); return res; };
  const call = async (path, body) => { const res = fakeRes(); await app.routes[path].handler({ body }, res); return res; };
  return { chatMod, route, post, call, requireInternal, sent };
}

test('POST /chat/spotlight is registered behind requireInternal', () => {
  const h = harness();
  assert.ok(h.route, 'route missing');
  assert.ok(h.route.middleware.includes(h.requireInternal), 'web asks it with the shared secret — never public');
});

test('setting a message broadcasts it, and a connecting client gets it as a connect frame', async () => {
  const h = harness();
  assert.deepEqual(h.chatMod.spotlightFrame(), { type: 'spotlight', spotlight: null },
    'nothing picked → the frame still goes out, carrying null (a reconnecting client must be told)');
  const res = await h.post({ spotlight: { platform: 'twitch', messageId: '17', extra: 'dropped' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.sent, [{ type: 'spotlight', spotlight: { platform: 'twitch', messageId: '17' } }],
    'exactly the two fields go on the wire — nothing else the caller sent');
  assert.deepEqual(h.chatMod.spotlightFrame(), { type: 'spotlight', spotlight: { platform: 'twitch', messageId: '17' } });
});

test('clearing broadcasts null, and the connect frame now carries null', async () => {
  const h = harness();
  await h.post({ spotlight: { platform: NATIVE_PLATFORM, messageId: 4 } });
  const res = await h.post({ spotlight: null });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.sent[1], { type: 'spotlight', spotlight: null });
  assert.deepEqual(h.chatMod.spotlightFrame(), { type: 'spotlight', spotlight: null });
});

test('deleting the picked message clears the pick; deleting another does not', async () => {
  const origWarn = console.warn; console.warn = () => {}; // the fake pool refuses the flag UPDATE
  try {
    const h = harness();
    await h.post({ spotlight: { platform: 'twitch', messageId: '17' } });
    await h.call('/chat/delete', { platform: 'twitch', messageId: '18' });
    assert.deepEqual(h.sent.map((f) => f.type), ['spotlight', 'delete'], 'another row: the pick stands');
    await h.call('/chat/delete', { platform: 'twitch', messageId: 17 });
    assert.deepEqual(h.sent.map((f) => f.type), ['spotlight', 'delete', 'delete', 'spotlight'],
      'the picked row (id matched as text — the web sends numbers for native rows): cleared for everyone');
    assert.deepEqual(h.sent[3], { type: 'spotlight', spotlight: null });
    assert.deepEqual(h.chatMod.spotlightFrame(), { type: 'spotlight', spotlight: null });
  } finally { console.warn = origWarn; }
});

test('a purge that includes the picked message clears the pick', async () => {
  const origWarn = console.warn; console.warn = () => {};
  try {
    const h = harness();
    await h.post({ spotlight: { platform: NATIVE_PLATFORM, messageId: 4 } });
    await h.call('/chat/purge', { items: [{ platform: NATIVE_PLATFORM, id: 3 }, { platform: NATIVE_PLATFORM, id: 4 }] });
    assert.deepEqual(h.sent.map((f) => f.type), ['spotlight', 'purge', 'spotlight']);
    assert.deepEqual(h.sent[2], { type: 'spotlight', spotlight: null });
  } finally { console.warn = origWarn; }
});

test('a body without the field, or a malformed pick, is a 400 and broadcasts nothing', async () => {
  for (const bad of [{}, { spotlight: 'x' }, { spotlight: {} }, { spotlight: { platform: 7, messageId: 1 } }, { spotlight: { platform: 'twitch' } }]) {
    const h = harness();
    const res = await h.post(bad);
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.chatMod.spotlightFrame(), { type: 'spotlight', spotlight: null });
  }
});

test('index.js hands the spotlight frame to ws-hub as a connect frame', () => {
  const src = readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.match(src.slice(-400), /\}\);\s*$/, 'END anchor: index.js read whole');
  const block = /connectFrames:\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(block, 'ws-hub is no longer given connectFrames');
  assert.match(block[1], /\(\)\s*=>\s*chatMod\.spotlightFrame\(\)/, 'the pick must replay on connect, or a reloaded OBS source loses it');
  assert.match(src, /const chatMod = registerChatMod\(app, \{/, 'the register call must keep its return value');
});
