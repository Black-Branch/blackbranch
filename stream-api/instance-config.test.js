// instance-config.js without a database: the credential cipher, the provider checks, the
// test fan-out to stream-ingest, and the routes' auth posture. The SQL paths run against real
// Postgres in instance-config.db.test.js.
// Run: node --test instance-config.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createInstanceConfig, encryptSecret, decryptSecret } = require('./instance-config');
const { runProviderCheck, normalizeCheckResult, describeCheck } = require('./instanceSchema.generated.js');

const MK = crypto.randomBytes(32);
const quiet = { log() {}, warn() {}, error() {} };

test('cipher: round trip, and the key NAME is bound in (AAD)', () => {
  const ct = encryptSecret('anthropic.apiKey', 'sk-secret-value', MK);
  assert.match(ct, /^v1:[\w-]+:[\w-]+:[\w-]+$/);
  assert.equal(decryptSecret('anthropic.apiKey', ct, MK), 'sk-secret-value');
  assert.throws(() => decryptSecret('openai.apiKey', ct, MK), 'a ciphertext moved to another key must not decrypt');
  assert.throws(() => decryptSecret('anthropic.apiKey', ct, crypto.randomBytes(32)), 'wrong key');
  const parts = ct.split(':');
  const flipped = parts[3][0] === 'A' ? 'B' + parts[3].slice(1) : 'A' + parts[3].slice(1);
  assert.throws(() => decryptSecret('anthropic.apiKey', [...parts.slice(0, 3), flipped].join(':'), MK), 'tampered');
  assert.notEqual(encryptSecret('k', 'same', MK), encryptSecret('k', 'same', MK), 'a fresh IV every time');
});

test('a malformed master key exits at construction', () => {
  let code = null;
  createInstanceConfig({ env: { INSTANCE_MASTER_KEY: 'nothex' }, log: quiet, exit: (c) => { code = c; } });
  assert.equal(code, 1);
});

test('before any load, get() answers from env and defaults (what process.env always did)', () => {
  const cfg = createInstanceConfig({ env: { BOT_MATRIX_ID: '@bot:example.tv' }, log: quiet });
  assert.equal(cfg.get('bot.matrixId'), '@bot:example.tv');
  assert.equal(cfg.resolve('bot.matrixId').envName, 'BOT_MATRIX_ID');
  // The public schema carries no owner-named alias.
  assert.equal(createInstanceConfig({ env: { ['GADGET' + '_MATRIX_ID']: '@bot:example.tv' }, log: quiet }).get('bot.matrixId'), null);
  // Product defaults: off, and 90 days.
  assert.equal(cfg.get('memory.enabled'), false);
  assert.equal(cfg.get('memory.retentionDays'), 90);
  assert.equal(cfg.get('ai.mode'), 'simple');
  assert.deepEqual(cfg.get('staff.extraMatrixIds'), []);
  assert.equal(cfg.get('elevenlabs.apiKey'), null);
  assert.throws(() => cfg.get('no.such.key'), /unknown instance key/);
});

function stubFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, res] of routes) if (re.test(String(url))) return typeof res === 'function' ? res(url, init) : res;
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  return f;
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('provider checks: one read each, a fixed CODE back, never the value or a provider text', async () => {
  const vals = {
    'anthropic.apiKey': 'sk-ant-SECRETVALUE', 'openai.apiKey': 'sk-oa-SECRETVALUE', 'elevenlabs.apiKey': 'el-SECRETVALUE',
    'stripe.secretKey': 'sk_live_FAKE_SECRETVALUE', 'paypal.clientId': 'pp-id', 'paypal.clientSecret': 'pp-SECRETVALUE',
    'paypal.env': 'sandbox', 'paypal.webhookId': 'WH-1', 'twitch.clientId': 'tw-id', 'twitch.clientSecret': 'tw-SECRETVALUE',
    'kick.clientId': 'k-id', 'kick.clientSecret': 'k-SECRETVALUE', 'youtube.apiKey': 'yt-SECRETVALUE',
  };
  const get = (k) => vals[k] ?? null;
  const f = stubFetch([
    [/anthropic\.com\/v1\/models/, json(200, { data: [{}, {}, {}] })],
    [/openai\.com\/v1\/models/, json(401, { error: { message: 'Incorrect API key provided: sk-oa-SECRETVALUE' } })],
    [/elevenlabs\.io\/v1\/models/, json(200, [{}, {}])],
    [/api\.stripe\.com\/v1\//, json(200, { data: [] })],
    [/sandbox\.paypal\.com\/v1\/oauth2\/token/, json(200, { access_token: 'AT' })],
    [/sandbox\.paypal\.com\/v1\/notifications\/webhooks\/WH-1/, json(200, { event_types: [{ name: '*' }] })],
    [/id\.twitch\.tv\/oauth2\/token/, json(200, { access_token: 'TT' })],
    [/id\.twitch\.tv\/oauth2\/validate/, json(200, {})],
    [/id\.kick\.com\/oauth\/token/, json(500, { message: 'internal: sk-echo' })],
    [/googleapis\.com\/youtube\/v3\/i18nLanguages/, json(200, {})],
  ]);
  const out = {};
  for (const t of ['anthropic', 'openai', 'elevenlabs', 'stripe', 'paypal', 'paypal-webhook', 'twitch', 'kick', 'youtube']) {
    out[t] = await runProviderCheck(t, get, f);
  }
  assert.deepEqual(out.anthropic, { ok: true, code: 'accepted', count: 3 });
  assert.deepEqual(out.openai, { ok: false, code: 'rejected', status: 401 });
  assert.deepEqual(out.stripe, { ok: true, code: 'accepted', mode: 'live' });
  assert.deepEqual(out['paypal-webhook'], { ok: true, code: 'accepted', mode: 'sandbox' });
  assert.deepEqual(out.kick, { ok: false, code: 'http_error', status: 500 });
  assert.equal(describeCheck(normalizeCheckResult(out.anthropic)), 'accepted — 3 listed');
  for (const r of Object.values(out)) assert.ok(!/SECRETVALUE|echo|Incorrect/.test(JSON.stringify(r)), JSON.stringify(r));
  for (const c of f.calls) {
    const m = (c.init.method || 'GET').toUpperCase();
    assert.ok(m === 'GET' || /oauth2?\/token/.test(c.url), `${m} ${c.url} is not a harmless read`);
  }
  assert.deepEqual(await runProviderCheck('openai', () => null, f), { ok: false, code: 'not_set', missing: ['openai.apiKey'] });
  assert.equal(await runProviderCheck('obs', get, f), null, "local checks are not the shared function's");
  const slow = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  assert.deepEqual(await runProviderCheck('anthropic', get, slow), { ok: false, code: 'timeout' });
});

test('ElevenLabs: a TTS-only scoped key is NOT a rejected key', async () => {
  // Prod's key is scoped: /v1/models + /v1/voices 200, /v1/user 401 missing_permissions, and TTS
  // plays. The old check called /v1/user and showed "rejected (HTTP 401)" for that working key.
  // A bad key answers HTTP 400 invalid_api_key — measured with a random key the same day.
  const get = (k) => (k === 'elevenlabs.apiKey' ? 'el-SECRETVALUE' : null);
  const run = (resp) => { const f = stubFetch([[/elevenlabs\.io\/v1\/models/, resp]]); return runProviderCheck('elevenlabs', get, f).then((r) => ({ r, f })); };

  const ok = await run(json(200, Array.from({ length: 11 }, () => ({}))));
  assert.deepEqual(ok.r, { ok: true, code: 'accepted', count: 11 });
  assert.equal(ok.f.calls.length, 1);
  assert.match(ok.f.calls[0].url, /\/v1\/models$/, 'tests with an endpoint a TTS-only key can read');

  const limited = await run(json(401, { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission user_read to execute this operation. el-SECRETVALUE' } }));
  assert.deepEqual(limited.r, { ok: true, code: 'limited', status: 401 });
  assert.deepEqual(normalizeCheckResult(limited.r), { ok: true, code: 'limited', status: 401 });
  assert.equal(describeCheck(normalizeCheckResult(limited.r)), 'key works, but lacks a permission this check needs');

  const bad401 = await run(json(401, { detail: { status: 'invalid_api_key', message: 'API key is invalid.' } }));
  assert.deepEqual(bad401.r, { ok: false, code: 'rejected', status: 401 });
  const bad400 = await run(json(400, { detail: { status: 'invalid_api_key', message: 'API key is invalid.' } }));
  assert.deepEqual(bad400.r, { ok: false, code: 'rejected', status: 400 }, 'ElevenLabs answers a bad key with 400');
  const unparsable = await run({ ok: false, status: 401, json: async () => { throw new Error('not json'); } });
  assert.deepEqual(unparsable.r, { ok: false, code: 'rejected', status: 401 });
  for (const x of [limited, bad401, bad400]) assert.ok(!/SECRETVALUE|permission|invalid\./.test(JSON.stringify(x.r)), 'no provider text is carried');
});

test('a scoped key lacking one permission reads limited on every provider that says so', async () => {
  const vals = { 'openai.apiKey': 'sk-oa', 'stripe.secretKey': 'rk_live_x' };
  const get = (k) => vals[k] ?? null;
  const f = stubFetch([
    [/openai\.com\/v1\/models/, json(401, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.', code: null } })],
    // A restricted key without Invoices: Read — 403 for that object type alone.
    [/api\.stripe\.com\/v1\/invoices/, json(403, { error: { type: 'invalid_request_error', message: "The provided key 'rk_live_***' does not have the required permissions for this endpoint." } })],
    [/api\.stripe\.com\/v1\//, json(200, { data: [] })],
  ]);
  assert.deepEqual(await runProviderCheck('openai', get, f), { ok: true, code: 'limited', status: 401 });
  assert.deepEqual(await runProviderCheck('stripe', get, f), { ok: false, code: 'denied', denied: ['invoices'], mode: 'live' },
    'a payment key that cannot read what the site reads is a failure, named by object type');
  const g = stubFetch([[/openai\.com\/v1\/models/, json(401, { error: { message: 'Incorrect API key provided: sk-oa' } })]]);
  assert.deepEqual(await runProviderCheck('openai', get, g), { ok: false, code: 'rejected', status: 401 }, 'a bad key stays rejected');
});

test('a reported check result is reduced to the fixed shape — no text survives', () => {
  assert.deepEqual(normalizeCheckResult({ ok: true, code: 'accepted', count: 2, detail: 'sk-live-LEAK', extra: 'x' }), { ok: true, code: 'accepted', count: 2 });
  assert.deepEqual(normalizeCheckResult({ ok: true, code: 'rejected', status: 401 }), { ok: false, code: 'rejected', status: 401 }, 'ok follows the code, not the claim');
  assert.deepEqual(normalizeCheckResult({ ok: true, code: 'pwned: sk-LEAK' }), { ok: false, code: 'unreadable' });
  assert.deepEqual(normalizeCheckResult({ code: 'not_set', missing: ['openai.apiKey', 'sk-LEAK'] }), { ok: false, code: 'not_set', missing: ['openai.apiKey'] });
  assert.deepEqual(normalizeCheckResult({ code: 'http_error', status: 'sk-LEAK' }), { ok: false, code: 'http_error' });
  assert.equal(describeCheck({ code: 'nope' }), 'unreadable result');
});

function fakePool() {
  const rows = [];
  return {
    rows,
    query: async (sql) => (/^SELECT/.test(sql.trim()) ? { rows: [] } : (rows.push(sql), { rows: [], rowCount: 1 })),
    connect: async () => { throw new Error('no writes in this test'); },
  };
}

test('Test fans out: in-process here, and to stream-ingest over the INTERNAL socket only', async () => {
  const internal = [];
  let cfg;
  const f = stubFetch([[/anthropic\.com/, json(200, { data: [{}] })]]);
  cfg = createInstanceConfig({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxx1234' }, log: quiet, fetchImpl: f });
  const pool = fakePool();
  await cfg.init({
    pool,
    sendInternal: (fr) => {
      internal.push(fr);
      // stream-ingest's side: it hears the frame and reports back with the nonce — and tries
      // to smuggle a text along, which must not survive.
      if (fr.type === 'config_test') {
        setImmediate(() => cfg.report({ package: 'stream-ingest', tests: [{ key: fr.key, nonce: fr.nonce, result: { ok: true, code: 'accepted', count: 1, detail: 'LEAKED-TEXT' }, source: 'env', last4: '1234' }] }));
      }
      return 1;
    },
  });
  const r = await cfg.test('anthropic.apiKey');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.package, x.ok, x.detail, x.source, x.last4]), [
    ['stream-api', true, 'accepted — 1 listed', 'env', '1234'],
    ['stream-ingest', true, 'accepted — 1 listed', 'env', '1234'],
  ]);
  assert.ok(!pool.rows.join(' ').includes('LEAKED'), 'nothing a reporter wrote is stored as text');
  const ft = internal.find((x) => x.type === 'config_test');
  assert.deepEqual(Object.keys(ft).sort(), ['key', 'nonce', 'type']);
  assert.equal((await cfg.test('anthropic.apiKey')).status, 429, 'cooldown');
  assert.equal((await cfg.test('kofi.verificationToken')).status, 400, 'no test available');
  assert.equal((await cfg.test('bot.matrixId')).status, 404, 'not a credential');
});

test('no internal socket connected: the ingest half says so at once instead of waiting', async () => {
  const cfg = createInstanceConfig({ env: { OPENAI_API_KEY: 'x' }, log: quiet });
  await cfg.init({ pool: fakePool(), sendInternal: () => 0 });
  const t0 = Date.now();
  const r = await cfg.test('openai.apiKey');
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(r.body.results.map((x) => [x.package, x.ok, x.detail]), [['stream-ingest', false, 'stream-ingest is not connected to stream-api']]);
});

test('writes are refused while this process has not loaded the layer', async () => {
  const cfg = createInstanceConfig({ env: {}, log: quiet });
  const r = await cfg.write('bot.matrixId', '@b:example.tv', 'a');
  assert.equal(r.status, 503);
});

test('every /config route is requireSecret — never the IP allowlist', () => {
  const seen = [];
  const app = {};
  for (const m of ['get', 'put', 'post', 'delete']) app[m] = (path, ...mw) => seen.push([m, path, mw[0]]);
  const requireSecret = () => {};
  createInstanceConfig({ log: quiet }).registerConfigRoutes(app, { requireSecret, wrap: (fn) => fn });
  assert.equal(seen.length, 6);
  for (const [m, p, first] of seen) assert.equal(first, requireSecret, `${m.toUpperCase()} ${p} is not guarded by the secret`);
});

test('a key with a declared writer (memory.state) is never written by an edit, only by its writer', async () => {
  const cfg = createInstanceConfig({ env: {}, log: quiet });
  const state = { model: 'm', connection: 'openai', dim: 8, since: '2026-01-01T00:00:00.000Z', status: 'on' };
  const put = await cfg.write('memory.state', state, '@admin:example.tv');
  assert.equal(put.status, 400);
  assert.match(put.body.error, /written by stream-api itself/);
  assert.equal((await cfg.clear('memory.state', '@admin:example.tv')).status, 400, 'DELETE /config/memory.state was allowed');
  // The writer's own path passes the writer check (and then meets the not-loaded refusal).
  assert.equal((await cfg.writeInternal('memory.state', state, 'stream-api:memory')).status, 503);
});

test('the doctor\'s Test (record:false) stores nothing, skips stream-ingest, keeps its own cooldown, and is advertised', async () => {
  const internal = [];
  const f = stubFetch([[/anthropic\.com/, json(200, { data: [{}] })]]);
  const cfg = createInstanceConfig({ env: { ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxx1234' }, log: quiet, fetchImpl: f });
  const pool = fakePool();
  await cfg.init({ pool, sendInternal: (fr) => { internal.push(fr); return 1; } });
  const r = await cfg.test('anthropic.apiKey', { record: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => [x.package, x.ok, x.detail]), [
    ['stream-api', true, 'accepted — 1 listed'],
    ['stream-ingest', null, 'not run by the doctor (stream-ingest stores its result)'],
  ]);
  assert.deepEqual(pool.rows, [], 'an unrecorded Test wrote nothing');
  assert.equal(internal.filter((x) => x.type === 'config_test').length, 0, 'stream-ingest was not asked (it would store its answer)');
  assert.equal((await cfg.test('anthropic.apiKey', { record: false })).status, 429, 'its own cooldown');
  // A recorded Test right after is not blocked by the doctor's run — and does store.
  const rec = cfg.test('anthropic.apiKey');
  setImmediate(() => { const fr = internal.find((x) => x.type === 'config_test'); if (fr) cfg.report({ package: 'stream-ingest', tests: [{ key: fr.key, nonce: fr.nonce, result: { ok: true, code: 'accepted' } }] }); });
  assert.equal((await rec).status, 200);
  assert.ok(pool.rows.length > 0, 'the normal Test still records');
  assert.deepEqual(cfg.snapshot().features, ['test-unrecorded'], 'web asks for this before it relies on it');
  // The route reads the flag from the body; anything but an explicit false records as before.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'instance-config.js'), 'utf8');
  assert.match(src, /await test\(req\.params\.key, \{ record: req\.body\?\.record !== false \}\)/);
});

test('a restart-applied key reports what this process RUNS — the first load\'s value — until the restart', async () => {
  let obs = false;
  const pool = {
    query: async (sql) => (/FROM site\.instance_config/.test(sql)
      ? { rows: [{ key: 'modules.obs', value: obs, updated_by: '@a:x', updated_at: new Date() }] }
      : { rows: [] }),
    connect: async () => { throw new Error('no writes in this test'); },
  };
  const cfg = createInstanceConfig({ env: {}, log: quiet });
  await cfg.init({ pool, sendInternal: () => 0 });
  assert.equal(cfg.snapshot().self['modules.obs'].display, false);
  obs = true;
  assert.equal(await cfg.load(), true);
  assert.equal(cfg.get('modules.obs'), true, 'the layer itself holds the saved value');
  assert.equal(cfg.snapshot().self['modules.obs'].display, false, 'the report must say the old value is still running');
});
