// The memory panel's flows against a REAL pgvector:
//   • Turn on: the probe's length sets the EMPTY column's type (vector(1536) → vector(768)), and
//     the HNSW index keeps serving (EXPLAIN); a store already holding rows is a change → refused;
//   • a model over 2,000 dimensions is probed again at 1,536 and stored as "reduced";
//   • Start fresh: without the exact count it only reports it; with it, the store is cleared and
//     retyped, and the new state is on; a plugin lock or a silent stream-ingest refuses it;
//   • a vector of the old length just after the flip is refused without an alarm, and after the
//     grace a wrong length pauses memory (the column itself refuses it too);
//   • Resume probes first: a still-refused key stays paused.
// It retypes the embedding column, so it runs in its OWN database (created and dropped here) —
// the shared test database's other suites must never see a vector(768) column.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test memory-panel.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createMemory } = require('./memory');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = { log() {}, warn() {}, error() {} };

/** A settings layer as memory.js uses it: get + writeInternal, values in a map. */
function fakeConfig(values = {}) {
  return {
    values,
    get: (k) => (k in values ? values[k] : null),
    writeInternal: async (k, v) => { values[k] = v; return { status: 200, body: { ok: true } }; },
    snapshot: () => ({ state: { loaded: true } }),
  };
}

/** The AI wrapper as memory.js uses it: a probe that answers what the test says. */
function fakeAi() {
  const a = {
    lock: null, reporting: true, probes: [],
    answer: (_c, _m, dims) => ({ ok: true, code: 'ok', dim: dims || 768, package: 'stream-ingest' }),
    lockOf: () => a.lock,
    ingestReporting: () => a.reporting,
    probeEmbed: async (c, m, dims) => { a.probes.push([c, m, dims ?? null]); return a.answer(c, m, dims); },
  };
  return a;
}

const vec = (n, x = 0.1) => Array.from({ length: n }, (_, i) => x + i * 1e-4);

test('memory panel flows against a real pgvector', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const admin = new Pool({ connectionString: URL });
  const dbName = `memory_panel_${process.pid}`;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new globalThis.URL(URL);
  u.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: u.toString() });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE IF EXISTS ${dbName}`); await admin.end(); });

  // The embeddings table as a real install has it (+ model, target_name), its HNSW index, and the audit log.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector; CREATE SCHEMA stream; CREATE SCHEMA site;
    CREATE TABLE stream.message_embeddings (
      id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, source_id BIGINT NOT NULL, username TEXT, message TEXT NOT NULL,
      embedding vector(1536) NOT NULL, model TEXT NOT NULL DEFAULT 'm', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      target_name TEXT, UNIQUE (source, source_id));
    CREATE INDEX message_embeddings_hnsw ON stream.message_embeddings USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX idx_message_embeddings_created_at ON stream.message_embeddings (created_at);
    CREATE TABLE site.mod_log (id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, target_id TEXT NOT NULL, performed_by TEXT NOT NULL, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE site.memory_opt_outs (matrix_id TEXT PRIMARY KEY);
    CREATE TABLE stream.chat_log (id BIGSERIAL PRIMARY KEY, user_id TEXT, is_deleted BOOLEAN NOT NULL DEFAULT false);
    CREATE TABLE site.chat_messages (id BIGSERIAL PRIMARY KEY, matrix_id TEXT, is_deleted BOOLEAN NOT NULL DEFAULT false);`);
  const colType = async () => (await pool.query(
    `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'stream.message_embeddings'::regclass AND attname = 'embedding'`)).rows[0].t;
  const insert = (dim, model, id) => pool.query(
    `INSERT INTO stream.message_embeddings (source, source_id, message, embedding, model) VALUES ('native', $1, 'hello there friend', $2::vector, $3)`,
    [id, `[${vec(dim).join(',')}]`, model]);

  const cfg = fakeConfig();
  const ai = fakeAi();
  const alarms = [];
  const mem = createMemory({ pool, config: cfg, ai, log: quiet, sleep: async () => {}, notify: (k) => alarms.push(k) });
  const actor = '@admin:example.tv';

  await t.test('Turn on, first embedder on an empty store: the column becomes vector(768), the index keeps serving', async () => {
    const r = await mem.enable({ connection: 'local', model: 'nomic-embed', actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.dim, r.body.retyped, r.body.reduced], [768, true, false]);
    assert.equal(await colType(), 'vector(768)');
    assert.deepEqual(cfg.values['ai.embeddings'], { connection: 'local', model: 'nomic-embed' });
    assert.equal(cfg.values['memory.enabled'], true);
    assert.deepEqual([cfg.values['memory.state'].dim, cfg.values['memory.state'].status, cfg.values['memory.state'].model], [768, 'on', 'nomic-embed']);
    const idx = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'message_embeddings_hnsw'`);
    assert.match(idx.rows[0].indexdef, /hnsw \(embedding vector_cosine_ops\)/, 'the HNSW index is gone or changed');
    for (let i = 1; i <= 3; i++) await insert(768, 'nomic-embed', i);
    await pool.query('SET enable_seqscan = off');
    const plan = (await pool.query(`EXPLAIN SELECT id FROM stream.message_embeddings ORDER BY embedding <=> $1::vector LIMIT 5`, [`[${vec(768).join(',')}]`])).rows.map((x) => x['QUERY PLAN']).join('\n');
    await pool.query('RESET enable_seqscan');
    assert.match(plan, /message_embeddings_hnsw/, `the HNSW index is not used after the retype:\n${plan}`);
  });

  await t.test('the column itself refuses a vector of another length', async () => {
    await assert.rejects(insert(1536, 'nomic-embed', 99), /expected 768 dimensions, not 1536/);
  });

  await t.test('Turn on again with the same embedder is a no-op; another embedder over rows needs Start fresh', async () => {
    const since = cfg.values['memory.state'].since;
    const same = await mem.enable({ connection: 'local', model: 'nomic-embed', actor });
    assert.deepEqual([same.status, same.body.already], [200, true]);
    assert.equal(cfg.values['memory.state'].since, since, 'a no-op turn-on rewrote the start date');
    const other = await mem.enable({ connection: 'openai', model: 'text-embedding-3-small', actor });
    assert.equal(other.status, 409);
    assert.equal(other.body.needsStartFresh, true);
    assert.equal(await colType(), 'vector(768)', 'a refused turn-on changed the column');
  });

  await t.test('a store with rows refuses a retype in the database too (not only our check)', async () => {
    await assert.rejects(pool.query('ALTER TABLE stream.message_embeddings ALTER COLUMN embedding TYPE vector(3)'), /expected 3 dimensions, not 768/);
  });

  await t.test('Start fresh: without the exact count it only answers the count; nothing changes', async () => {
    const r = await mem.startFresh({ connection: 'openai', model: 'text-embedding-3-small', confirm: null, actor });
    assert.deepEqual([r.status, r.body.needConfirm, r.body.count, r.body.ok], [200, true, 3, undefined], 'the count read is an answer, and not an ok');
    const wrong = await mem.startFresh({ connection: 'openai', model: 'text-embedding-3-small', confirm: 2, actor });
    assert.equal(wrong.status, 409);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stream.message_embeddings')).rows[0].n, 3);
    assert.equal(cfg.values['memory.state'].status, 'on');
  });

  await t.test('Start fresh refuses under a plugin lock, and while stream-ingest is silent (a lock would be invisible)', async () => {
    ai.lock = 'the owner bot\'s memory';
    let r = await mem.startFresh({ connection: 'openai', model: 'text-embedding-3-small', confirm: 3, actor });
    assert.deepEqual([r.status, r.body.lockedBy], [409, 'the owner bot\'s memory']);
    r = await mem.enable({ connection: 'local', model: 'nomic-embed', actor });
    assert.equal(r.status, 409);
    ai.lock = null; ai.reporting = false;
    r = await mem.startFresh({ connection: 'openai', model: 'text-embedding-3-small', confirm: 3, actor });
    assert.equal(r.status, 503);
    ai.reporting = true;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stream.message_embeddings')).rows[0].n, 3);
  });

  await t.test('Start fresh with the exact count: cleared, retyped to the new length, on, audited', async () => {
    ai.answer = () => ({ ok: true, code: 'ok', dim: 1536, package: 'stream-ingest' });
    const r = await mem.startFresh({ connection: 'openai', model: 'text-embedding-3-small', confirm: 3, actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.cleared, r.body.dim], [3, 1536]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM stream.message_embeddings')).rows[0].n, 0);
    assert.equal(await colType(), 'vector(1536)');
    assert.deepEqual([cfg.values['memory.state'].status, cfg.values['memory.state'].model, cfg.values['memory.state'].dim], ['on', 'text-embedding-3-small', 1536]);
    const log = await pool.query(`SELECT action, performed_by, reason FROM site.mod_log WHERE action = 'memory_start_fresh'`);
    assert.equal(log.rows.length, 1);
    assert.match(log.rows[0].reason, /^3 memories cleared/);
  });

  await t.test('a late vector of the OLD length just after the flip is refused without an alarm; later it pauses', async () => {
    const r = await mem.store({ source: 'native', source_id: 50, message: 'late', embedding: vec(768), model: 'nomic-embed' });
    assert.deepEqual([r.status, r.body.error], [409, 'stale_vector']);
    assert.equal(alarms.length, 0);
    cfg.values['memory.state'] = { ...cfg.values['memory.state'], since: new Date(Date.now() - 120_000).toISOString() };
    const later = await mem.store({ source: 'native', source_id: 51, message: 'late', embedding: vec(768), model: 'nomic-embed' });
    assert.equal(later.status, 400);
    assert.deepEqual(alarms, ['memory.paused']);
    assert.equal(cfg.values['memory.state'].status, 'paused');
  });

  await t.test('Resume probes first: a key still refused stays paused; a good probe resumes', async () => {
    ai.answer = () => ({ ok: false, code: 'key_rejected', package: 'stream-ingest' });
    let r = await mem.resume();
    assert.deepEqual([r.ok, r.error], [false, 'key_rejected']);
    assert.equal(cfg.values['memory.state'].status, 'paused');
    ai.answer = () => ({ ok: true, code: 'ok', dim: 1024, package: 'stream-ingest' });
    r = await mem.resume();
    assert.deepEqual([r.ok, r.error], [false, 'dim_mismatch'], 'a probe at the wrong length must not resume');
    ai.answer = () => ({ ok: true, code: 'ok', dim: 1536, package: 'stream-ingest' });
    r = await mem.resume();
    assert.equal(r.ok, true);
    assert.equal(cfg.values['memory.state'].status, 'on');
    assert.equal(cfg.values['memory.state'].pausedReason, undefined);
  });

  await t.test('over 2,000 dimensions: probed again at 1,536 and stored as reduced; a model that cannot shrink is refused', async () => {
    await pool.query('TRUNCATE stream.message_embeddings');
    cfg.values['memory.state'] = null; cfg.values['memory.enabled'] = false;
    ai.probes.length = 0;
    ai.answer = (_c, _m, dims) => ({ ok: true, code: 'ok', dim: dims || 3072, package: 'stream-ingest' });
    const r = await mem.enable({ connection: 'openai', model: 'text-embedding-3-large', actor });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.dim, r.body.reduced], [1536, true]);
    assert.deepEqual(ai.probes, [['openai', 'text-embedding-3-large', null], ['openai', 'text-embedding-3-large', 1536]]);
    assert.equal(cfg.values['memory.state'].reduced, true);
    cfg.values['memory.state'] = null;
    ai.answer = () => ({ ok: true, code: 'ok', dim: 3072, package: 'stream-ingest' });
    const no = await mem.enable({ connection: 'local', model: 'big', actor });
    assert.deepEqual([no.status, no.body.code], [422, 'too_many_dimensions']);
  });

  await t.test('/memory/search: nearest people\'s lines only — never deleted, recent, past retention, or the bot\'s own', async () => {
    await pool.query('TRUNCATE stream.message_embeddings');
    cfg.values['memory.state'] = { model: 'm', connection: 'openai', dim: 1536, since: new Date(Date.now() - 86400_000).toISOString(), status: 'on' };
    cfg.values['memory.enabled'] = true;
    cfg.values['memory.retentionDays'] = 30;
    cfg.values['bot.matrixId'] = '@bot:example.tv';
    const q = vec(1536, 0.2);
    const near = (d) => vec(1536, 0.2 + d);
    const add = async (source, sourceId, username, message, emb, ageDays = 1) => pool.query(
      `INSERT INTO stream.message_embeddings (source, source_id, username, message, embedding, model, created_at)
       VALUES ($1, $2, $3, $4, $5::vector, 'm', now() - make_interval(days => $6::int))`, [source, sourceId, username, message, `[${emb.join(',')}]`, ageDays]);
    const cl = async (deleted) => (await pool.query('INSERT INTO stream.chat_log (user_id, is_deleted) VALUES ($1, $2) RETURNING id', ['c1', deleted])).rows[0].id;
    const cm = async (mx, deleted) => (await pool.query('INSERT INTO site.chat_messages (matrix_id, is_deleted) VALUES ($1, $2) RETURNING id', [mx, deleted])).rows[0].id;
    await add('platform', await cl(false), 'kate', 'I love pineapple pizza', near(0));
    await add('platform', await cl(true), 'kate', 'DELETED line', near(0));
    await add('native', await cm('@v:example.tv', false), 'vic', 'native line', near(0.001));
    await add('native', await cm('@v:example.tv', true), 'vic', 'DELETED native', near(0));
    await add('native', await cm('@bot:example.tv', false), 'Helper', 'BOT own native line', near(0));
    await add('platform', await cl(false), 'helperbot', 'BOT twitch line', near(0));
    await add('bot', 900, 'Helper', 'BOT plugin line', near(0));
    await add('platform', await cl(false), 'old', 'PAST retention', near(0), 45);
    await pool.query(`INSERT INTO stream.message_embeddings (source, source_id, username, message, embedding, model, created_at)
       VALUES ('platform', $1, 'now', 'RECENT line', $2::vector, 'm', now())`, [await cl(false), `[${near(0).join(',')}]`]);
    await add('platform', await cl(false), 'far', 'FAR away', vec(1536, -5).map((x, i) => (i % 2 ? x : -x)));
    await add('platform', await cl(false), 'long', 'L'.repeat(800), near(0.002));
    // Orphans: the source message was hard-deleted (or never existed) — nothing left to check.
    await add('platform', 987654321, 'kate', 'ORPHAN platform line', near(0));
    await add('native', 987654321, 'vic', 'ORPHAN native line', near(0));
    const r = await mem.search({ vector: q, excludeNames: ['helperbot', '@Helper'] });
    const texts = r.rows.map((x) => x.message);
    assert.deepEqual(texts.filter((x) => /DELETED|BOT|PAST|RECENT|FAR|ORPHAN/.test(x)), [], `excluded rows came back: ${texts.join(' | ')}`);
    assert.ok(texts.includes('I love pineapple pizza') && texts.includes('native line'), `people's lines missing: ${texts.join(' | ')}`);
    assert.ok(r.rows.length <= 5);
    assert.ok(r.rows.every((x) => x.message.length <= 300 && x.distance <= 0.55));
    assert.ok(texts.reduce((n, x) => n + x.length, 0) <= 1500);
    cfg.values['memory.state'] = { ...cfg.values['memory.state'], status: 'paused' };
    assert.deepEqual((await mem.search({ vector: q })).rows, [], 'a paused memory answered');
    cfg.values['memory.state'] = { ...cfg.values['memory.state'], status: 'on' };
    assert.equal((await mem.search({ vector: vec(768) })).error, 'dim_mismatch');
  });
});
