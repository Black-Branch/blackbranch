'use strict';

// /chat/native and the client message id (v173), executed through the route with a recording pool.
// A key the database already holds for this sender is a REPLAY: the first row's id comes back and
// nothing else happens (no broadcast, no corpus row). The real-schema half is
// chat-native-replay.db.test.js.
process.env.BOT_MATRIX_ID = process.env.BOT_MATRIX_ID || '@helperbot:site.test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');

const LINE = '0b9d3a52-5c1e-4f3e-9a52-7f1d2c3b4a59';

function harness({ stored = null } = {}) {
  const frames = [];
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO site\.chat_messages/.test(sql)) {
        // The unique index: a stored key inserts nothing.
        return stored != null && params.includes(LINE) ? { rows: [], rowCount: 0 } : { rows: [{ id: 7 }], rowCount: 1 };
      }
      if (/FROM site\.chat_messages/.test(sql)) return { rows: stored != null ? [{ id: stored }] : [], rowCount: stored != null ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'abc', resolveCanonical: async () => 'abc',
    pronouns: { get: async () => null, set: async () => true, maybeAlejo: () => {} },
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [],
    broadcast: (m) => frames.push(m), bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const native = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['POST /chat/native']({ body, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  return { frames, queries, native };
}

const line = (over = {}) => ({ matrixId: '@kate:site.test', username: 'kate', message: 'hey', ...over });
const inserts = (h) => h.queries.filter((q) => /INSERT INTO site\.chat_messages/.test(q.sql));

test('a fresh key is stored with the line', async () => {
  const h = harness();
  const res = await h.native(line({ clientMsgId: LINE }));
  assert.deepEqual(res.body, { ok: true, id: 7 });
  const [ins] = inserts(h);
  assert.match(ins.sql, /client_msg_id/);
  assert.match(ins.sql, /ON CONFLICT \(matrix_id, client_msg_id\) WHERE client_msg_id IS NOT NULL DO NOTHING/);
  assert.ok(ins.params.includes(LINE), 'the key was not written');
  assert.equal(h.frames.filter((f) => f.type === 'message').length, 1);
});

test('retry: a stored key answers the first row and does nothing else', async () => {
  const h = harness({ stored: 41 });
  const res = await h.native(line({ clientMsgId: LINE }));
  assert.deepEqual(res.body, { ok: true, id: 41, replay: true });
  assert.equal(h.frames.length, 0, 'a replay was broadcast');
  assert.equal(h.queries.filter((q) => /stream\.chat_log/.test(q.sql) && /INSERT/.test(q.sql)).length, 0, 'a replay wrote a corpus row');
});

test('no key, or a malformed one, stores NULL: the old behaviour', async () => {
  for (const clientMsgId of [undefined, 'nope', 42, '0b9d3a52-5c1e-4f3e-9a52-7f1d2c3b4a59x']) {
    const h = harness();
    const res = await h.native(line(clientMsgId === undefined ? {} : { clientMsgId }));
    assert.equal(res.body.id, 7);
    assert.ok(inserts(h)[0].params.includes(null), 'a malformed key must be stored as NULL');
    assert.ok(!inserts(h)[0].params.includes(clientMsgId ?? '__none__'));
  }
});
