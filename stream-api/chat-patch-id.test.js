'use strict';
// PATCH /chat/:id/{karma,intelligence} must refuse a non-numeric id.
//
// A dedup-suppressed echo's /chat response carries no id, so a scorer can
// PATCH `/chat/undefined/karma`; handing "undefined" to Postgres raises
// `invalid input syntax for type bigint` as an UNHANDLED 500. A route that cannot act
// on its input says so with a 400; it does not throw from inside pg.
//
// Run: node --test chat-patch-id.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');

function harness() {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'abc', resolveCanonical: async () => null,
    pollEngine: {}, msgBuffer: [], broadcast: () => {}, bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const patch = async (path, id, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[`PATCH ${path}`]({ params: { id }, body }, res);
    return res;
  };
  return { patch, queries };
}

for (const field of ['karma', 'intelligence']) {
  test(`PATCH /chat/:id/${field} with a non-numeric id is a 400, and touches no row`, async () => {
    const h = harness();
    for (const bad of ['undefined', '', 'abc', '12abc', 'null', '9223372036854775808', '99999999999999999999999']) {
      const res = await h.patch(`/chat/:id/${field}`, bad, { score: 0.5 });
      assert.equal(res.statusCode, 400, `id ${JSON.stringify(bad)} was accepted`);
    }
    assert.equal(h.queries.length, 0, 'a refused id must never reach Postgres');
  });

  test(`PATCH /chat/:id/${field} with a numeric id updates that row`, async () => {
    const h = harness();
    const res = await h.patch(`/chat/:id/${field}`, '4242', { score: 0.5 });
    assert.equal(res.statusCode, 200);
    assert.equal(h.queries.length, 1);
    assert.deepEqual(h.queries[0].params, [0.5, '4242']);
    const top = await h.patch(`/chat/:id/${field}`, '9223372036854775807', { score: 0.5 });
    assert.equal(top.statusCode, 200, 'the largest bigint is a valid id');
  });
}
