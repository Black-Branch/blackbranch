// memory.js's store against a REAL Postgres: the boot dimension
// check, adopting an existing store, pause on a mismatch, the /embedding writer's refusals, the
// retention purge and the offline backfills' model guard. A mock pool cannot show what the
// column's type really says, or that a purge removed only what it should.
//
// Fixtures: source_ids 8_400_000–8_400_999, created_at in 1990 for the purge. Removed before and
// after. Every check that could touch other files' rows runs inside a transaction that is rolled
// back.
//
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test memory-store.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createMemory, storeRefusesModel } = require('./memory');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const STATE = { model: 'embed-a', connection: 'openai', dim: 1536, since: '2026-01-01T00:00:00.000Z', status: 'on' };
const vec = (n, i = 0) => `[${Array.from({ length: n }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;

/** A settings layer: plain values, a loaded flag, and memory.state written in place. */
function fakeConfig(values, { loaded = true } = {}) {
  const v = { 'memory.enabled': true, 'memory.retentionDays': null, ...values };
  const writes = [];
  return {
    values: v, writes,
    get: (k) => (k in v ? v[k] : null),
    snapshot: () => ({ state: { loaded } }),
    writeInternal: async (key, value, by) => { writes.push({ key, value, by }); v[key] = value; return { status: 200, body: { ok: true } }; },
  };
}

async function clean(db) {
  await db.query(`DELETE FROM stream.message_embeddings WHERE source_id BETWEEN 8400000 AND 8400999`);
}

test('memory store, against a real database', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 4 });
  t.after(async () => { await clean(pool); await pool.end(); });
  await clean(pool);

  /** Run `fn(client)` in a transaction that is always rolled back. It takes the store EXCLUSIVE
   *  first: these cases empty the table and count what is left (models, rows), and `node --test`
   *  runs the other embedding test files in parallel — under READ COMMITTED a row one of them
   *  commits mid-case shows up in the count. Their writes wait for the rollback instead. */
  async function inTx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('LOCK TABLE stream.message_embeddings IN EXCLUSIVE MODE');
      return await fn(c);
    } finally { await c.query('ROLLBACK'); c.release(); }
  }
  const typmod = async (db) => (await db.query(
    `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'stream.message_embeddings'::regclass AND attname = 'embedding'`)).rows[0].atttypmod;

  await t.test('the boot check reads the column\'s dimension and passes when the state agrees', async () => {
    const cfg = fakeConfig({ 'memory.state': STATE });
    const notes = [];
    const m = createMemory({ pool, config: cfg, notify: (...a) => notes.push(a), log: quiet });
    assert.equal(await m.readColumnDim(), 1536, 'the replayed column is not vector(1536)');
    await m.boot();
    assert.equal(cfg.writes.length, 0, 'a passing check wrote something');
    assert.equal(notes.length, 0);
    assert.equal(m.dim(), 1536);
  });

  await t.test('a state that disagrees with the column PAUSES memory with exactly one alarm', async () => {
    const cfg = fakeConfig({ 'memory.state': { ...STATE, dim: 768 } });
    const notes = [];
    const m = createMemory({ pool, config: cfg, notify: (...a) => notes.push(a), log: quiet });
    await m.boot();
    await m.pause('dim_mismatch');
    assert.equal(cfg.writes.length, 1, 'one pause, one write');
    assert.equal(cfg.values['memory.state'].status, 'paused');
    assert.equal(cfg.values['memory.state'].pausedReason, 'dim_mismatch');
    assert.equal(notes.length, 1, 'one alarm per pause, not one per call');
    assert.equal(notes[0][0], 'memory.paused');
    const r = await m.resume();
    assert.equal(r.ok, false, 'resumed onto a column of another dimension');
  });

  await t.test('an existing single-model store is ADOPTED from the column and its oldest row — no DDL', async () => {
    await inTx(async (db) => {
      const before = await typmod(db);
      await db.query(`DELETE FROM stream.message_embeddings`);
      await db.query(
        `INSERT INTO stream.message_embeddings (source, source_id, message, embedding, model, created_at)
         VALUES ('platform', 8400001, 'a', $1::vector, 'embed-a', '2026-06-22T00:00:00Z'),
                ('native', 8400002, 'b', $2::vector, 'embed-a', '2026-07-01T00:00:00Z')`, [vec(1536, 1), vec(1536, 2)]);
      const cfg = fakeConfig({ 'ai.embeddings': { connection: 'openai', model: 'embed-a' } });
      const m = createMemory({ pool: db, config: cfg, log: quiet });
      await m.boot();
      const s = cfg.values['memory.state'];
      assert.ok(s, 'nothing was adopted');
      assert.deepEqual({ ...s, since: new Date(s.since).toISOString() },
        { model: 'embed-a', connection: 'openai', dim: 1536, since: '2026-06-22T00:00:00.000Z', status: 'on' });
      assert.equal(await typmod(db), before, 'the column type changed — DDL ran');
    });
  });

  await t.test('an empty store, or one holding two models, is not adopted', async () => {
    await inTx(async (db) => {
      await db.query(`DELETE FROM stream.message_embeddings`);
      const cfg = fakeConfig({ 'ai.embeddings': { connection: 'openai', model: 'embed-a' } });
      await createMemory({ pool: db, config: cfg, log: quiet }).boot();
      assert.equal(cfg.values['memory.state'], undefined, 'an empty store was adopted (the probe flow sets the first embedder)');
      await db.query(
        `INSERT INTO stream.message_embeddings (source, source_id, message, embedding, model)
         VALUES ('platform', 8400003, 'a', $1::vector, 'embed-a'), ('platform', 8400004, 'b', $1::vector, 'embed-b')`, [vec(1536)]);
      await createMemory({ pool: db, config: cfg, log: quiet }).boot();
      assert.equal(cfg.values['memory.state'], undefined, 'a two-model store was adopted');
    });
  });

  await t.test('/embedding: off and paused are 409 (nothing stored); a wrong length is 400 and pauses', async () => {
    const row = { source: 'platform', source_id: 8400010, username: 'x', message: 'hello there friend', embedding: JSON.parse(vec(1536)) };
    const count = async () => Number((await pool.query(`SELECT count(*) FROM stream.message_embeddings WHERE source_id = 8400010`)).rows[0].count);
    const off = createMemory({ pool, config: fakeConfig({ 'memory.state': STATE, 'memory.enabled': false }), log: quiet });
    assert.equal((await off.store(row)).status, 409);
    const paused = createMemory({ pool, config: fakeConfig({ 'memory.state': { ...STATE, status: 'paused', pausedReason: 'quota' } }), log: quiet });
    assert.equal((await paused.store(row)).status, 409);
    assert.equal(await count(), 0);
    const cfg = fakeConfig({ 'memory.state': STATE });
    const on = createMemory({ pool, config: cfg, log: quiet });
    const wrong = await on.store({ ...row, embedding: JSON.parse(vec(1535)) });
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'dim_mismatch']);
    assert.equal(cfg.values['memory.state'].status, 'paused', 'a wrong-length vector did not pause memory');
    assert.equal(await count(), 0);
    // The happy path, with the state's model when the caller sends none.
    const ok = createMemory({ pool, config: fakeConfig({ 'memory.state': STATE }), log: quiet });
    assert.equal((await ok.store(row)).status, 200);
    const stored = (await pool.query(`SELECT model FROM stream.message_embeddings WHERE source_id = 8400010`)).rows;
    assert.deepEqual(stored, [{ model: 'embed-a' }]);
  });

  await t.test('retention: forever deletes nothing; a number deletes only older rows; an unloaded layer deletes nothing', async () => {
    await inTx(async (db) => {
      await db.query(
        `INSERT INTO stream.message_embeddings (source, source_id, message, embedding, created_at)
         VALUES ('platform', 8400020, 'old', $1::vector, '1990-01-01T00:00:00Z'),
                ('platform', 8400021, 'new', $1::vector, now())`, [vec(1536)]);
      const ours = (await db.query(`SELECT source_id FROM stream.message_embeddings WHERE source_id IN (8400020, 8400021) ORDER BY 1`)).rows.map((r) => Number(r.source_id));
      assert.deepEqual(ours, [8400020, 8400021]);
      const forever = createMemory({ pool: db, config: fakeConfig({ 'memory.state': STATE }), log: quiet });
      assert.equal(await forever.purgeExpired(), 0);
      const unloaded = createMemory({ pool: db, config: fakeConfig({ 'memory.state': STATE, 'memory.retentionDays': 3650 }, { loaded: false }), log: quiet });
      assert.equal(await unloaded.purgeExpired(), 0, 'purged on an unloaded settings layer — that is the default answering');
      const tenYears = createMemory({ pool: db, config: fakeConfig({ 'memory.state': STATE, 'memory.retentionDays': 3650 }), log: quiet });
      assert.ok(await tenYears.purgeExpired() >= 1);
      const left = (await db.query(`SELECT source_id FROM stream.message_embeddings WHERE source_id IN (8400020, 8400021)`)).rows.map((r) => Number(r.source_id));
      assert.deepEqual(left, [8400021], 'the purge removed the wrong rows');
    });
  });

  await t.test('a backfill refuses a store that is off or holds another model', async () => {
    await inTx(async (db) => {
      await db.query(`DELETE FROM site.instance_config WHERE key = 'memory.state'`);
      assert.match(await storeRefusesModel(db, 'embed-a'), /not on/);
      await db.query(`INSERT INTO site.instance_config (key, value, updated_by) VALUES ('memory.state', $1::jsonb, 'test')`, [JSON.stringify(STATE)]);
      assert.equal(await storeRefusesModel(db, 'embed-a'), null);
      assert.match(await storeRefusesModel(db, 'embed-b'), /holds embed-a/);
    });
  });
});
