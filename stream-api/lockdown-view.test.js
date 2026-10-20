// site.lockdown_now against a real schema (expiry, and "until the stream ends"). Every lever reader in
// web and here reads the view, so the view IS the rule. Runs in one transaction that is rolled
// back: the replayed CI database is left as it was. Same database as sql-parse.test.js.
//
// Run locally: SQL_PARSE_DATABASE_URL=postgres://… node --test lockdown-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';

test('the levers hold while the tied stream is live, lift when it ends, and stay off when the next one starts', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — see the sql-parse job');
    t.skip('SQL_PARSE_DATABASE_URL not set (local run without a throwaway Postgres)');
    return;
  }
  const db = new Client({ connectionString: URL });
  await db.connect();
  const now = async () => (await db.query('SELECT sub_only, ingest_paused, expired, until_stream FROM site.lockdown_now WHERE id = 1')).rows[0];
  try {
    await db.query('BEGIN');
    await db.query('INSERT INTO site.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await db.query("INSERT INTO stream.sessions (stream_id, started_at) VALUES ('test-live-1', now() - interval '1 hour')");
    await db.query("UPDATE site.lockdown SET sub_only = true, ingest_paused = '{kick}', expires_at = NULL, until_stream = 'test-live-1' WHERE id = 1");

    let r = await now();
    assert.equal(r.expired, false);
    assert.equal(r.sub_only, true);
    assert.deepEqual(r.ingest_paused, ['kick']);

    await db.query("UPDATE stream.sessions SET ended_at = now() WHERE stream_id = 'test-live-1'");
    r = await now();
    assert.equal(r.expired, true, 'the stream ended: every lever reads off');
    assert.equal(r.sub_only, false);
    assert.deepEqual(r.ingest_paused, []);

    await db.query("INSERT INTO stream.sessions (stream_id, started_at) VALUES ('test-live-2', now())");
    r = await now();
    assert.equal(r.expired, true, 'a later stream never turns it back on');

    await db.query("UPDATE site.lockdown SET until_stream = 'no-such-stream' WHERE id = 1");
    assert.equal((await now()).expired, true, 'a stream id that is not in stream.sessions reads off');

    await db.query("UPDATE site.lockdown SET until_stream = NULL, expires_at = now() - interval '1 minute' WHERE id = 1");
    assert.equal((await now()).expired, true, 'the v147 expiry still applies');
    await db.query("UPDATE site.lockdown SET expires_at = now() + interval '1 hour' WHERE id = 1");
    r = await now();
    assert.equal(r.expired, false);
    assert.equal(r.sub_only, true);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
});
