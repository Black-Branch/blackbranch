// Against a REAL Postgres (v173): /chat/native stores the sender's client message id, and a second
// attempt at the same line, even one racing the first, leaves ONE row and ONE broadcast. A mock pool
// cannot reject illegal SQL or enforce the unique index, so this runs the real handler on the real schema.
// Fixtures are scoped to `@cr-` matrix ids and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test chat-native-replay.db.test.js
'use strict';

process.env.BOT_MATRIX_ID = process.env.BOT_MATRIX_ID || '@helperbot:site.test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createChat } = require('./chat');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const KATE = '@cr-kate:site.test';
const LEE = '@cr-lee:site.test';

/** One stream-api process: its own in-memory state, the shared database. */
function instance(pool) {
  const frames = [];
  const chat = createChat({
    pool, resolveOrCreate: async () => null, resolveCanonical: async () => null,
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
    return res;
  };
  return { frames, native, messages: () => frames.filter((f) => f.type === 'message') };
}

test('a client message id against the real schema', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 6 });
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.chat_messages WHERE matrix_id LIKE '@cr-%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@cr-%'`);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  for (const m of [KATE, LEE]) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  const rows = async (matrixId, key) => (await pool.query(
    `SELECT id FROM site.chat_messages WHERE matrix_id = $1 AND client_msg_id = $2`, [matrixId, key])).rows;

  await t.test('retry: the same key again answers the first row, stores nothing, broadcasts nothing', async () => {
    const api = instance(pool);
    const key = randomUUID();
    const first = await api.native({ matrixId: KATE, username: 'kate', message: 'hey', clientMsgId: key });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.ok, true);
    assert.ok(Number.isInteger(first.body.id), 'the first attempt stored a row');
    assert.notEqual(first.body.replay, true);
    const again = await api.native({ matrixId: KATE, username: 'kate', message: 'hey', clientMsgId: key });
    assert.deepEqual(again.body, { ok: true, id: first.body.id, replay: true });
    assert.equal((await rows(KATE, key)).length, 1, 'the retry stored a second row');
    assert.equal(api.messages().length, 1, 'the retry was broadcast a second time');
  });

  await t.test('two attempts racing each other: one row, one broadcast, both answer its id', async () => {
    const api = instance(pool);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      api.native({ matrixId: KATE, username: 'kate', message: 'race', clientMsgId: key }),
      api.native({ matrixId: KATE, username: 'kate', message: 'race', clientMsgId: key }),
    ]);
    const stored = await rows(KATE, key);
    assert.equal(stored.length, 1, 'the unique index let two rows in');
    assert.equal(a.body.id, Number(stored[0].id));
    assert.equal(b.body.id, Number(stored[0].id));
    assert.equal([a.body.replay, b.body.replay].filter(Boolean).length, 1, 'exactly one attempt is the replay');
    assert.equal(api.messages().length, 1, 'both racing attempts were broadcast');
  });

  await t.test('restart: a new process answers a key the old one stored', async () => {
    const key = randomUUID();
    const before = await instance(pool).native({ matrixId: KATE, username: 'kate', message: 'restart', clientMsgId: key });
    const after = instance(pool);
    const res = await after.native({ matrixId: KATE, username: 'kate', message: 'restart', clientMsgId: key });
    assert.deepEqual(res.body, { ok: true, id: before.body.id, replay: true });
    assert.equal(after.messages().length, 0);
  });

  await t.test('a key is per sender; no key is the old behaviour; a malformed key is ignored', async () => {
    const api = instance(pool);
    const key = randomUUID();
    const k = await api.native({ matrixId: KATE, username: 'kate', message: 'same', clientMsgId: key });
    const l = await api.native({ matrixId: LEE, username: 'lee', message: 'same', clientMsgId: key });
    assert.notEqual(k.body.id, l.body.id, "another person's line with the same key was swallowed");
    const n1 = await api.native({ matrixId: KATE, username: 'kate', message: 'lol' });
    const n2 = await api.native({ matrixId: KATE, username: 'kate', message: 'lol' });
    assert.notEqual(n1.body.id, n2.body.id, 'two keyless lines must both post');
    const bad = await api.native({ matrixId: KATE, username: 'kate', message: 'bad', clientMsgId: 'not-a-uuid' });
    assert.equal(bad.statusCode, 200, 'a malformed key must not fail the send');
    assert.equal((await pool.query(`SELECT client_msg_id FROM site.chat_messages WHERE id = $1`, [bad.body.id])).rows[0].client_msg_id, null);
  });
});
