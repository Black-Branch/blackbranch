// POST /chat/announce — the DM window's announcement fan-out, driven through the
// REAL register function against a fake app (chat-spotlight.test.js's harness).
//
// Run: node --test chat-announce.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerChatMod } = require('./chat-mod');

function harness() {
  const routes = {};
  const app = { post: (path, ...h) => { routes[path] = { middleware: h.slice(0, -1), handler: h[h.length - 1] }; } };
  const sent = [];
  const requireInternal = (req, res, next) => next();
  registerChatMod(app, {
    pool: { query: async () => { throw new Error('no db in this test'); } },
    msgBuffer: [], broadcast: (f) => sent.push(f), redactBuffered: () => {},
    requireInternal, wrap: (fn) => fn,
  });
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path].handler({ body }, res);
    return res;
  };
  return { routes, sent, call, requireInternal };
}

test('the route is registered behind requireInternal — web asks with the shared secret', () => {
  const h = harness();
  for (const p of ['/chat/announce']) {
    assert.ok(h.routes[p], `${p} missing`);
    assert.ok(h.routes[p].middleware.includes(h.requireInternal), `${p} must never be public`);
  }
});

test('an announcement goes out once, trimmed, with only the fields the frame names', async () => {
  const h = harness();
  const res = await h.call('/chat/announce', { id: 'a1', text: '  stream in 5  ', by: 'casey', extra: 'dropped' });
  assert.equal(res.statusCode, 200);
  assert.equal(h.sent.length, 1);
  const f = h.sent[0];
  assert.deepEqual(Object.keys(f).sort(), ['at', 'by', 'id', 'text', 'type']);
  assert.equal(f.type, 'announce');
  assert.equal(f.text, 'stream in 5');
  assert.equal(f.by, 'casey');
  assert.equal(typeof f.at, 'number');
});

test('an announcement without text, too long, or without a clean id is refused and nothing is sent', async () => {
  const h = harness();
  for (const body of [{ id: 'a', text: '   ' }, { id: 'a', text: 'x'.repeat(301) }, { text: 'hi' }, { id: 'bad id!', text: 'hi' }, null]) {
    const res = await h.call('/chat/announce', body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(h.sent.length, 0);
  assert.equal((await h.call('/chat/announce', { id: 'a', text: 'x'.repeat(300) })).statusCode, 200, 'the limit itself is allowed');
});

