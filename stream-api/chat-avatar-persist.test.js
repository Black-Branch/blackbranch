'use strict';
// stream.users.avatar_url: the /chat route keeps the last profile
// picture a platform chatter was seen with — one UPDATE per CHANGE, never per
// message, and nothing when the message carries no picture. Executed through
// the route with a recording pool, not scanned.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');

function harness() {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } };
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
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['POST /chat']({ body, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  const avatarWrites = () => queries.filter((q) => /UPDATE stream\.users SET avatar_url/.test(q.sql));
  return { post, queries, avatarWrites };
}

const msg = (over = {}) => ({ platform: 'youtube', userId: 'u1', username: 'kate', message: 'hello', ...over });

test('a picture on the message is written once for the canonical, and only again when it CHANGES', async () => {
  const h = harness();
  await h.post(msg({ avatarUrl: 'https://yt/a.png' }));
  assert.equal(h.avatarWrites().length, 1);
  assert.deepEqual(h.avatarWrites()[0].params, ['https://yt/a.png', 'abc']);
  assert.match(h.avatarWrites()[0].sql, /AND avatar_url IS DISTINCT FROM \$1/);
  await h.post(msg({ avatarUrl: 'https://yt/a.png' }));
  await h.post(msg({ avatarUrl: 'https://yt/a.png' }));
  assert.equal(h.avatarWrites().length, 1, 'the same picture again is not a second write');
  await h.post(msg({ avatarUrl: 'https://yt/b.png' }));
  assert.equal(h.avatarWrites().length, 2, 'a new picture is written');
});

test('no picture on the message → no write at all', async () => {
  const h = harness();
  await h.post(msg());
  await h.post(msg({ avatarUrl: '' }));
  assert.equal(h.avatarWrites().length, 0);
});
