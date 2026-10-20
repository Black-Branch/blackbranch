'use strict';
// Native (site) messages get the same karma/intelligence scores as platform
// chat. stream-ingest scores the live WS frame, which carries the
// SITE id (site.chat_messages.id); the score belongs on the parallel
// stream.chat_log row /chat/native writes after its response — platform
// = the site's own platform id, platform_msg_id = the site id — because that row is what the
// Leaderboard and every karma aggregate read. Executed through the route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./chat');

function harness(rowCount = 1) {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount }; } };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'abc', resolveCanonical: async () => null,
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [], broadcast: () => {}, bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const patch = async (siteId, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['PATCH /chat/native/:siteId/scores']({ params: { siteId }, body }, res);
    return res;
  };
  const updates = () => queries.filter((q) => /UPDATE stream\.chat_log/.test(q.sql));
  return { patch, updates };
}

test('a score lands on the native chat_log row found by the SITE id, never on a chat_log id', async () => {
  const h = harness();
  const res = await h.patch('4242', { karma: 0.8 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(h.updates().length, 1);
  const { sql, params } = h.updates()[0];
  assert.match(sql, /WHERE platform IN \('native'[^)]*\) AND platform_msg_id = \$3/);
  assert.match(sql, /karma = COALESCE\(\$1::double precision, karma\), intelligence = COALESCE\(\$2::double precision, intelligence\)/);
  assert.deepEqual(params, [0.8, null, '4242']);
});

test('karma and intelligence arrive separately and each leaves the other alone', async () => {
  const h = harness();
  await h.patch('7', { intelligence: 0.35 });
  assert.deepEqual(h.updates()[0].params, [null, 0.35, '7']);
});

test('no row yet (the corpus write runs after /chat/native answers) → 404 not_found, so ingest can try once more', async () => {
  const h = harness(0);
  const res = await h.patch('9', { karma: 0.5 });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { ok: false, error: 'not_found' });
});

test('a bad id or a score outside 0..1 is the caller\'s mistake: 400, and nothing is written', async () => {
  for (const [id, body] of [
    ['undefined', { karma: 0.5 }], ['12a', { karma: 0.5 }], ['99999999999999999999', { karma: 0.5 }],
    ['5', {}], ['5', { karma: 1.5 }], ['5', { karma: -0.1 }], ['5', { intelligence: 'x' }], ['5', { karma: null, intelligence: null }],
  ]) {
    const h = harness();
    const res = await h.patch(id, body);
    assert.equal(res.statusCode, 400, `${id} ${JSON.stringify(body)}`);
    assert.equal(h.updates().length, 0);
  }
});

test('END anchor: the route is registered in chat.js', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8');
  assert.match(src, /app\.patch\('\/chat\/native\/:siteId\/scores', requireInternal/);
  assert.match(src.slice(-120), /module\.exports = \{ createChat \};\s*$/);
});
