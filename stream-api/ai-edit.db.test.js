// The AI page's edits against a REAL Postgres: the settings layer's tables with the AI wrapper's write guard plugged in, exactly as index.js wires them.
//   • what an edit MEANS is refused with a reason: an unknown task, an unknown connection, a
//     connection still in use, a task the connection cannot do, the embedder by a plain edit;
//   • a custom connection's key is a pattern key, encrypted, sent to stream-ingest only, and
//     refused for a connection that does not exist;
//   • a key is bound to its address: moving a connection's origin, or removing it, deletes the
//     key in the SAME transaction, with a history row;
//   • an edit applies on the next call with no restart (the route is resolved per call);
//   • Detect / Test run in stream-ingest when it answers, here when it is not connected, and
//     nothing but a code, ids and numbers comes back.
// No network: every provider request goes to a recording fake fetch.
//
// Fixtures: slot ids `yy…` (ai.db.test.js owns `zz…` and runs in parallel), the AI keys and `ai.connection.*` secrets; every table is emptied before and after,
// so this must only ever point at a THROWAWAY database.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test ai-edit.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createInstanceConfig } = require('./instance-config');
const { createAi } = require('./ai');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const MK = 'cd'.repeat(32);
const LOCAL_KEY = 'sk-local-THIS-MUST-NEVER-APPEAR-7a7a';
const quiet = { log() {}, warn() {}, error() {} };

async function clean(pool) {
  for (const t of ['instance_config', 'instance_secrets', 'instance_history', 'instance_secret_tests']) await pool.query(`DELETE FROM site.${t}`);
  await pool.query(`DELETE FROM site.ai_slots WHERE slot_id LIKE 'yy%'`);
}

test('AI edits against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  // `node --test` runs files in parallel, and this file and its sibling (instance-config.db /
  // ai-edit.db) both empty the site.instance_* tables: one session-held advisory lock makes them
  // take turns instead of wiping each other's fixtures mid-run.
  const lock = await pool.connect();
  await lock.query('SELECT pg_advisory_lock(135135)');
  await clean(pool);
  t.after(async () => { await clean(pool); await lock.query('SELECT pg_advisory_unlock(135135)'); lock.release(); await pool.end(); });

  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, auth: init.headers && init.headers.authorization, model: init.body ? JSON.parse(init.body).model : null });
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'bad id <x>' }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  };
  const frames = [];
  let ingestAnswers = null; // (frame) => result, or null = ingest not connected
  const cfg = createInstanceConfig({ env: { INSTANCE_MASTER_KEY: MK }, log: quiet, exit: () => assert.fail('must not exit') });
  const ai = createAi({ config: () => cfg, env: {}, fetchImpl, log: quiet, notify: () => {} });
  ai.registerSlots('yy-test', [
    { id: 'yy.chat', kind: 'chat', label: 'YY chat', defaultRoute: { connection: 'anthropic', model: 'claude-x' } },
    { id: 'yy.news', kind: 'chat', label: 'YY news', needs: ['serverWebSearch'], defaultRoute: { connection: 'anthropic', model: 'claude-x' } },
  ]);
  const sendInternal = (f) => {
    frames.push(f);
    if (f.type === 'config_ai_probe' && ingestAnswers) {
      const result = ingestAnswers(f);
      setImmediate(() => cfg.report({ package: 'stream-ingest', reply: { nonce: f.nonce, result } }));
      return 1;
    }
    return f.type === 'config_ai_probe' ? 0 : 1;
  };
  assert.equal(await cfg.init({ pool, sendInternal, writeGuard: (k, v) => ai.writeGuard(k, v) }), true);
  await ai.start({ pool });
  t.after(() => ai.stop());
  const put = (k, v) => cfg.write(k, v, 'test:admin');
  const LOCAL = { id: 'local', kind: 'openai-compatible', label: 'Local', baseUrl: 'http://10.0.0.5:11434/v1' };

  await t.test('a connection, its key (encrypted, pattern key, stream-ingest only), and the refusals', async () => {
    let r = await put('ai.connection.local.apiKey', LOCAL_KEY);
    assert.equal(r.status, 400, 'a key for a connection that does not exist was stored');
    assert.match(r.body.error, /add the connection first/);
    assert.equal((await put('ai.connections', [LOCAL])).status, 200);
    r = await put('ai.connection.local.apiKey', LOCAL_KEY);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await pool.query(`SELECT ciphertext, last4 FROM site.instance_secrets WHERE key = 'ai.connection.local.apiKey'`);
    assert.ok(row.rows[0].ciphertext.startsWith('v1:') && !row.rows[0].ciphertext.includes('NEVER'), 'stored in clear');
    assert.equal(row.rows[0].last4, '7a7a');
    assert.equal(cfg.get('ai.connection.local.apiKey'), LOCAL_KEY);
    assert.equal(cfg.secretsFor('stream-ingest').values['ai.connection.local.apiKey'], LOCAL_KEY);
    assert.equal(cfg.secretsFor('web').values['ai.connection.local.apiKey'], undefined, 'web was sent a key it never uses');
    assert.ok(!JSON.stringify(cfg.snapshot()).includes('NEVER'), 'the snapshot carries a key value');
    assert.equal((await put('ai.connection.Bad_Id.apiKey', 'x'.repeat(20))).status, 404, 'a key name outside the pattern was accepted');
  });

  await t.test('tasks: unknown task / connection, a need the connection lacks, the embedder — each refused with a reason', async () => {
    let r = await put('ai.tasks', { 'no.such': { enabled: true } });
    assert.equal(r.status, 400); assert.match(r.body.error, /no task "no\.such"/);
    r = await put('ai.tasks', { 'helpdesk.answer': { enabled: true, connection: 'nope', model: 'm' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /no connection "nope"/);
    r = await put('ai.tasks', { 'yy.news': { connection: 'local', model: 'llama3.2' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /server web search/);
    r = await put('ai.tasks', { embeddings: { enabled: true } });
    assert.equal(r.status, 400); assert.match(r.body.error, /memory panel/);
    r = await put('ai.embeddings', { connection: 'local', model: 'nomic' });
    assert.equal(r.status, 400, 'the embedder was changed by a plain edit');
    assert.equal((await put('ai.default', { connection: 'nope', model: 'm' })).status, 400);
  });

  await t.test('an edit applies on the NEXT call, no restart; a custom connection sends its own key', async () => {
    assert.equal(ai.route('helpdesk.answer').enabled, false, 'a product task ran before it was switched on');
    assert.equal((await put('ai.tasks', { 'helpdesk.answer': { enabled: true, connection: 'local', model: 'llama3.2' } })).status, 200);
    let r = ai.route('helpdesk.answer');
    assert.deepEqual([r.connection.id, r.model, r.source], ['local', 'llama3.2', 'db']);
    requests.length = 0;
    await ai.chat('helpdesk.answer', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(requests[0].url, 'http://10.0.0.5:11434/v1/chat/completions');
    assert.equal(requests[0].auth, `Bearer ${LOCAL_KEY}`);
    assert.equal(requests[0].model, 'llama3.2');
    assert.equal((await put('ai.tasks', { 'helpdesk.answer': { enabled: true, connection: 'local', model: 'qwen3' } })).status, 200);
    requests.length = 0;
    await ai.chat('helpdesk.answer', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(requests[0].model, 'qwen3', 'the next call did not carry the new model');
    // Simple mode + a default: the default runs every chat task (plugins included).
    assert.equal((await put('ai.default', { connection: 'local', model: 'llama3.2' })).status, 200);
    r = ai.route('yy.chat');
    assert.deepEqual([r.connection.id, r.model], ['local', 'llama3.2']);
    assert.equal((await put('ai.mode', 'advanced')).status, 200);
    assert.equal(ai.route('helpdesk.answer').model, 'qwen3', 'advanced mode ignored the task\'s own model');
  });

  await t.test('a connection in use cannot be removed; a new origin or a removal deletes its key in the same transaction', async () => {
    let r = await put('ai.connections', []);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /still used by the default model, helpdesk\.answer/);
    assert.equal(cfg.get('ai.connection.local.apiKey'), LOCAL_KEY, 'a refused write touched the key');
    // Same origin, new path: the key stays.
    r = await put('ai.connections', [{ ...LOCAL, baseUrl: 'http://10.0.0.5:11434/api/v1' }]);
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, undefined, 'a same-origin edit cleared the key');
    assert.equal(cfg.get('ai.connection.local.apiKey'), LOCAL_KEY);
    // New origin: the key goes, with a history row, and every process is told.
    r = await put('ai.connections', [{ ...LOCAL, baseUrl: 'http://10.0.0.6:11434/v1' }]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.cleared, ['ai.connection.local.apiKey']);
    assert.equal(cfg.get('ai.connection.local.apiKey'), null, 'the key followed the connection to a new address');
    const h = await pool.query(`SELECT action FROM site.instance_history WHERE key = 'ai.connection.local.apiKey' ORDER BY id`);
    assert.deepEqual(h.rows.map((x) => x.action), ['set', 'clear']);
    assert.deepEqual(frames.filter((f) => f.type === 'config_changed').at(-1), { type: 'config_changed', keys: ['ai.connections', 'ai.connection.local.apiKey'] });
    // Free it, then remove it: allowed, and its (re-saved) key is deleted with it.
    assert.equal((await put('ai.connection.local.apiKey', LOCAL_KEY)).status, 200);
    assert.equal((await cfg.clear('ai.default', 'test:admin')).status, 200);
    assert.equal((await put('ai.tasks', {})).status, 200);
    r = await put('ai.connections', []);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cleared, ['ai.connection.local.apiKey']);
    assert.equal((await pool.query(`SELECT 1 FROM site.instance_secrets WHERE key LIKE 'ai.connection.%'`)).rowCount, 0);
    // A connection with no stored key: nothing is reported as cleared that was not stored.
    assert.equal((await put('ai.connections', [{ ...LOCAL, id: 'spare' }])).status, 200);
    r = await put('ai.connections', []);
    assert.equal(r.status, 200);
    assert.equal(r.body.cleared, undefined, 'a keyless removal reported a cleared key');
  });

  await t.test('Detect / Test: stream-ingest answers when connected; here otherwise; only codes, ids and numbers come back', async () => {
    ingestAnswers = (f) => (f.op === 'detect'
      ? { ok: true, code: 'ok', models: ['gpt-x', 'evil <script>'], text: 'provider said sk-ECHO' }
      : { ok: false, code: 'key_rejected', latencyMs: 12, message: 'sk-ECHO' });
    let r = await ai.check('detect', 'openai');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { package: 'stream-ingest', ok: true, code: 'ok', models: ['gpt-x'] });
    r = await ai.check('test', 'helpdesk.answer');
    assert.deepEqual(r.body, { package: 'stream-ingest', ok: false, code: 'key_rejected', latencyMs: 12 });
    assert.equal((await ai.check('test', 'helpdesk.answer')).status, 429, 'no cooldown');
    // This process's own plugin slot runs here, whatever ingest says.
    requests.length = 0;
    r = await ai.check('test', 'yy.chat');
    assert.equal(r.body.package, 'stream-api');
    assert.equal(r.body.code, 'key_missing', 'a test without a key made a request');
    assert.equal(requests.length, 0);
    // Ingest not connected: the check runs here.
    ingestAnswers = null;
    assert.equal((await put('ai.connections', [LOCAL])).status, 200);
    r = await ai.check('detect', 'local');
    assert.deepEqual(r.body, { package: 'stream-api', ok: true, code: 'ok', models: ['llama3.2'] });
    assert.equal((await ai.check('detect', 'nope')).status, 404);
    assert.equal((await ai.check('test', 'no.such')).status, 404);
    assert.ok(!JSON.stringify(r).includes('ECHO'), 'vacuity: the last answer was read');
  });
});
