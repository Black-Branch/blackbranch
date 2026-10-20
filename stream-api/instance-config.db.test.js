// The instance settings layer (instance-config.js) against a REAL Postgres — its tables, through
// the runtime driver. A mock pool cannot reject illegal SQL, so every write path here runs for real: set, overwrite, clear, history, a stored
// credential encrypted and decrypted, a test result recorded.
//
// Fixture keys are real schema keys (the writer refuses any other); every table is emptied of
// them before and after, so this must only ever point at a THROWAWAY database.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test instance-config.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createInstanceConfig } = require('./instance-config');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const MK = 'ab'.repeat(32);
const FAKE_SECRET = 'sk-test-THIS-MUST-NEVER-APPEAR-9f3c';
const quiet = { log() {}, warn() {}, error() {} };

async function clean(pool) {
  for (const t of ['instance_config', 'instance_secrets', 'instance_history', 'instance_secret_tests']) {
    await pool.query(`DELETE FROM site.${t}`);
  }
}

test('instance-config against real Postgres', { skip: !URL && 'SQL_PARSE_DATABASE_URL not set (CI sets it)' }, async (t) => {
  const pool = new Pool({ connectionString: URL });
  // `node --test` runs files in parallel, and this file and its sibling (instance-config.db /
  // ai-edit.db) both empty the site.instance_* tables: one session-held advisory lock makes them
  // take turns instead of wiping each other's fixtures mid-run.
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock(135135)');
  await clean(pool);
  t.after(async () => { await clean(pool); await lock.query('SELECT pg_advisory_unlock(135135)'); lock.release(); await pool.end(); });

  const frames = [];
  const cfg = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK }, log: quiet, exit: () => assert.fail('must not exit') });
  assert.equal(await cfg.init({ pool, sendInternal: (f) => { frames.push(f); return 1; } }), true, 'first load against an empty layer');

  await t.test('a plain value: set, overwrite, history, broadcast, resolve', async () => {
    let r = await cfg.write('bot.matrixId', '@bot:example.tv', 'test:admin');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(cfg.resolve('bot.matrixId'), { value: '@bot:example.tv', source: 'database', envName: null, error: null });
    r = await cfg.write('bot.matrixId', '@other:example.tv', 'test:admin');
    assert.equal(r.status, 200);
    const h = await pool.query(`SELECT action, old_value, new_value, updated_by FROM site.instance_history WHERE key='bot.matrixId' ORDER BY id`);
    assert.deepEqual(h.rows.map((x) => [x.action, x.old_value, x.new_value, x.updated_by]), [
      ['set', null, '@bot:example.tv', 'test:admin'],
      ['set', '@bot:example.tv', '@other:example.tv', 'test:admin'],
    ]);
    assert.deepEqual(frames.at(-1), { type: 'config_changed', keys: ['bot.matrixId'] }, 'the frame carries key names only');
  });

  await t.test('a list round-trips as JSON', async () => {
    const r = await cfg.write('staff.extraMatrixIds', ['@a:example.tv', '@b:example.tv'], 'test:admin');
    assert.equal(r.status, 200);
    assert.deepEqual(cfg.get('staff.extraMatrixIds'), ['@a:example.tv', '@b:example.tv']);
  });

  await t.test('refusals: unknown key, install tier, bad value, no author', async () => {
    assert.equal((await cfg.write('no.such.key', 'x', 'a')).status, 404);
    assert.equal((await cfg.write('site.origin', 'https://evil.example', 'a')).status, 400);
    assert.equal((await cfg.write('bot.matrixId', 'not-an-id', 'a')).status, 400);
    assert.equal((await cfg.write('bot.matrixId', '@x:example.tv', '')).status, 400);
    const n = await pool.query(`SELECT count(*)::int AS n FROM site.instance_config WHERE key = 'site.origin'`);
    assert.equal(n.rows[0].n, 0);
  });

  await t.test('a credential is stored encrypted, decrypts on reload, and never appears in /config', async () => {
    const r = await cfg.write('anthropic.apiKey', FAKE_SECRET, 'test:admin');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await pool.query(`SELECT ciphertext, last4 FROM site.instance_secrets WHERE key='anthropic.apiKey'`)).rows[0];
    assert.match(row.ciphertext, /^v1:/);
    assert.ok(!row.ciphertext.includes(FAKE_SECRET));
    assert.equal(row.last4, '9f3c');
    const hist = (await pool.query(`SELECT old_value, new_value, last4 FROM site.instance_history WHERE key='anthropic.apiKey'`)).rows;
    assert.deepEqual(hist, [{ old_value: null, new_value: null, last4: '9f3c' }], 'history keeps last4 only');
    // A fresh process with the same key reads it back.
    const again = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK }, log: quiet, exit: () => assert.fail('exit') });
    await again.init({ pool });
    assert.equal(again.get('anthropic.apiKey'), FAKE_SECRET);
    assert.deepEqual(again.secretsFor('stream-ingest').values, { 'anthropic.apiKey': FAKE_SECRET });
    assert.deepEqual(again.secretsFor('web').values, {}, 'web does not consume this key');
    const snap = JSON.stringify(again.snapshot());
    assert.ok(!snap.includes(FAKE_SECRET), 'the snapshot must never carry a secret');
    assert.match(snap, /…9f3c/);
    // env still beats the stored value.
    const envWins = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK, ANTHROPIC_API_KEY: 'from-env-000000000000' }, log: quiet, exit: () => {} });
    await envWins.init({ pool });
    assert.equal(envWins.resolve('anthropic.apiKey').source, 'env');
  });

  await t.test('stored credentials + a missing or wrong master key = exit, not silence', async () => {
    let code = null;
    const noKey = createInstanceConfig({ env: {}, log: quiet, exit: (c) => { code = c; } });
    await noKey.init({ pool });
    assert.equal(code, 1, 'missing key with stored credentials must exit');
    code = null;
    const wrong = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: 'cd'.repeat(32) }, log: quiet, exit: (c) => { code = c; } });
    await wrong.init({ pool });
    assert.equal(code, 1, 'a key that decrypts nothing must exit');
  });

  await t.test('clear returns a key to its default and records it', async () => {
    const r = await cfg.clear('bot.matrixId', 'test:admin');
    assert.deepEqual(r.body, { ok: true, key: 'bot.matrixId', removed: true });
    assert.equal(cfg.resolve('bot.matrixId').source, 'unset');
    const last = (await pool.query(`SELECT action, old_value FROM site.instance_history WHERE key='bot.matrixId' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.deepEqual(last, { action: 'clear', old_value: '@other:example.tv' });
    assert.equal((await cfg.clear('anthropic.apiKey', 'test:admin')).body.removed, true);
  });

  await t.test('reports are sanitised; test results land in instance_secret_tests', async () => {
    const r = await cfg.report({
      package: 'stream-ingest',
      keys: {
        'openai.apiKey': { source: 'env', envName: 'OPENAI_API_KEY', display: FAKE_SECRET },  // a buggy reporter
        'kick.clientId': { source: 'env', envName: 'KICK_CLIENT_ID', display: '…abcd' },
        'stripe.secretKey': { source: 'env', display: '…zzzz' },                            // not ingest's key
      },
      tests: [{ key: 'openai.apiKey', result: { ok: true, code: 'accepted', count: 3 }, detail: FAKE_SECRET, source: 'env', last4: 'wxyz' }],
    });
    assert.equal(r.status, 200);
    const snap = cfg.snapshot();
    assert.equal(snap.reports['stream-ingest'].keys['openai.apiKey'].display, null, 'a full value is dropped, not stored');
    assert.equal(snap.reports['stream-ingest'].keys['kick.clientId'].display, '…abcd');
    assert.equal(snap.reports['stream-ingest'].keys['stripe.secretKey'], undefined);
    assert.ok(!JSON.stringify(snap).includes(FAKE_SECRET));
    const row = (await pool.query(`SELECT package, ok, detail, last4 FROM site.instance_secret_tests WHERE key='openai.apiKey'`)).rows[0];
    assert.deepEqual(row, { package: 'stream-ingest', ok: true, detail: 'accepted — 3 listed', last4: 'wxyz' });
    assert.equal((await cfg.report({ package: 'stream-api' })).status, 400, 'stream-api does not report to itself');
  });

  await t.test('ONE unreadable stored credential is an error, an alert and a flag — never a quiet default', async () => {
    await cfg.write('elevenlabs.apiKey', 'el-good-value-000000000001', 'test:admin');
    await cfg.write('youtube.apiKey', 'yt-good-value-000000000002', 'test:admin');
    // Corrupt one row the way a wrong-key restore or a hand edit would.
    await pool.query(`UPDATE site.instance_secrets SET ciphertext = 'v1:AAAA:BBBB:CCCC' WHERE key = 'youtube.apiKey'`);
    const alerts = [];
    let code = null;
    const p = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK }, log: quiet, exit: (c) => { code = c; } });
    await p.init({ pool, notify: (...a) => alerts.push(a) });
    assert.equal(code, null, 'one bad row of two is not the all-fail exit');
    assert.equal(p.get('elevenlabs.apiKey'), 'el-good-value-000000000001');
    const r = p.resolve('youtube.apiKey');
    assert.equal(r.value, null);
    assert.equal(r.source, 'database');
    assert.match(r.error, /stored credential cannot be read/);
    const snap = p.snapshot();
    assert.equal(snap.secrets['youtube.apiKey'].readable, false);
    assert.match(snap.self['youtube.apiKey'].error, /cannot be read/);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0][2], /youtube\.apiKey/);
    assert.deepEqual(p.secretsFor('web').unreadable, ['youtube.apiKey'], 'other processes learn the key is broken, not absent');
    // env still overrides a broken stored value.
    const e = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK, YOUTUBE_API_KEY: 'from-env-key-0000' }, log: quiet, exit: () => {} });
    await e.init({ pool });
    assert.equal(e.resolve('youtube.apiKey').source, 'env');
    await pool.query(`DELETE FROM site.instance_secrets`);
  });

  await t.test('a write whose re-read fails answers 500 and tells NOBODY to re-read', async () => {
    const sent = [];
    let breakReads = false;
    const flaky = {
      query: (sql, params) => (breakReads && /^SELECT key, value/.test(sql) ? Promise.reject(new Error('db gone')) : pool.query(sql, params)),
      connect: () => pool.connect(),
    };
    const w = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK }, log: quiet, exit: () => {} });
    await w.init({ pool: flaky, sendInternal: (f) => { sent.push(f); return 1; } });
    breakReads = true;
    const r = await w.write('platform.kick.userId', '12345', 'test:admin');
    assert.equal(r.status, 500);
    assert.match(r.body.error, /could not re-read/);
    assert.deepEqual(sent, [], 'no config_changed after a failed re-read');
    assert.ok(w.snapshot().state.failingSince, 'the stale state is visible');
  });
});
