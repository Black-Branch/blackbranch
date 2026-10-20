// stream-ingest's instance settings reader (lib/instanceConfig.js) against a stub stream-api:
// the database layer arrives over HTTP, env still wins, a config_changed frame re-reads, a
// config_test frame runs the check HERE and reports it with the nonce, and a missing
// required install value is a boot problem.
// Run: node --test lib/instanceConfig.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstanceConfig } from './instanceConfig.js';

const quiet = { log() {}, warn() {}, error() {} };
const BASE = { STREAM_API_URL: 'http://api.test', STREAM_API_SECRET: 's3cret' };

function stubApi({ values = {}, secrets = {}, content = {}, fail = false } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    if (String(url).startsWith('https://api.anthropic.com/')) return { ok: true, status: 200, json: async () => ({ data: [{}, {}] }) };
    if (String(url).endsWith('/config')) return { ok: true, status: 200, json: async () => ({ values }) };
    if (String(url).includes('/config/secrets?package=stream-ingest')) return { ok: true, status: 200, json: async () => ({ values: secrets }) };
    if (String(url).endsWith('/content')) return { ok: true, status: 200, json: async () => ({ content }) };
    if (String(url).endsWith('/config/report')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    throw new Error(`unexpected ${url}`);
  };
  f.calls = calls;
  return f;
}

// Point the module's streamApiBase() at the stub for the duration of the file.
process.env.STREAM_API_URL = BASE.STREAM_API_URL;

test('the database layer comes from stream-api, with the secret, and env still wins', async () => {
  const api = stubApi({ values: { 'platform.twitch.broadcasterId': '42' }, secrets: { 'openai.apiKey': 'sk-db-000000000000' } });
  const cfg = createInstanceConfig({ env: { ...BASE, TWITCH_CHANNEL: 'envchannel' }, fetchImpl: api, log: quiet });
  assert.equal(cfg.get('platform.twitch.broadcasterId'), null, 'before the load: env + defaults only');
  assert.equal(await cfg.load(), true);
  assert.deepEqual(cfg.resolve('platform.twitch.broadcasterId'), { value: '42', source: 'database', envName: null, error: null });
  assert.equal(cfg.get('openai.apiKey'), 'sk-db-000000000000');
  assert.equal(cfg.resolve('platform.twitch.channel').source, 'env');
  for (const c of api.calls) assert.equal(c.headers.Authorization, 'Bearer s3cret');
  // A failed reload keeps the last good layer.
  const down = stubApi({ fail: true });
  const cfg2 = createInstanceConfig({ env: BASE, fetchImpl: down, log: quiet });
  assert.equal(await cfg2.load(), false);
  assert.equal(cfg2.get('openai.apiKey'), null);
  assert.equal(cfg2.state().loaded, false, 'the stale state is visible');
  assert.ok(cfg2.state().failingSince);
  cfg2.stop();
});

test('the status report carries sources and …last4, never a secret', async () => {
  const api = stubApi({ secrets: { 'anthropic.apiKey': 'sk-ant-THIS-IS-SECRET-wxyz' } });
  const cfg = createInstanceConfig({ env: { ...BASE, KICK_CLIENT_ID: 'kick-client-id-1234' }, fetchImpl: api, log: quiet });
  await cfg.load();
  const r = cfg.statusReport();
  assert.deepEqual(r['anthropic.apiKey'], { source: 'database', envName: null, display: '…wxyz', error: null });
  assert.deepEqual(r['kick.clientId'], { source: 'env', envName: 'KICK_CLIENT_ID', display: '…1234', error: null });
  assert.equal(r['stripe.secretKey'], undefined, 'only keys this process consumes');
  assert.ok(!JSON.stringify(r).includes('THIS-IS-SECRET'));
});

test('config_changed for one of OUR keys re-reads and re-reports; someone else\'s is ignored', async () => {
  const api = stubApi({ values: { 'bot.matrixId': '@bot:example.tv' } });
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: api, log: quiet });
  await cfg.handleFrame({ type: 'config_changed', keys: ['stripe.secretKey'] });
  assert.equal(api.calls.length, 0, 'a web-only key is none of this process\'s business');
  await cfg.handleFrame({ type: 'config_changed', keys: ['bot.matrixId'] });
  assert.equal(cfg.get('bot.matrixId'), '@bot:example.tv');
  assert.ok(api.calls.some((c) => c.url.endsWith('/config/report') && c.body.package === 'stream-ingest'));
});

test('config_test runs the provider check HERE with this process\'s value and reports the nonce', async () => {
  const api = stubApi();
  const cfg = createInstanceConfig({ env: { ...BASE, ANTHROPIC_API_KEY: 'sk-ant-from-ingest-env-9876' }, fetchImpl: api, log: quiet });
  await cfg.handleFrame({ type: 'config_test', key: 'anthropic.apiKey', nonce: 'n-1' });
  const rep = api.calls.find((c) => c.url.endsWith('/config/report'));
  assert.ok(rep, 'no report sent');
  assert.deepEqual(rep.body.tests, [{ key: 'anthropic.apiKey', nonce: 'n-1', result: { ok: true, code: 'accepted', count: 2 }, source: 'env', last4: '9876' }]);
  assert.ok(!JSON.stringify(rep.body).includes('from-ingest-env'), 'the value itself is never sent');
  api.calls.length = 0;
  await cfg.handleFrame({ type: 'config_test', key: 'stripe.secretKey', nonce: 'n-2' });
  assert.equal(api.calls.length, 0, 'a key this process does not hold is not tested here');
});

test('config_ai_probe: the AI page\'s Detect / Test run HERE through the AI wrapper, answered as a reply with the nonce', async () => {
  const api = stubApi({ values: { 'ai.connections': [{ id: 'local', kind: 'openai-compatible', label: 'L', baseUrl: 'http://10.0.0.5:11434/v1' }] },
    secrets: { 'ai.connection.local.apiKey': 'sk-local-stored-key-5555' } });
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: api, log: quiet });
  await cfg.load();
  assert.equal(cfg.get('ai.connection.local.apiKey'), 'sk-local-stored-key-5555', 'a stored pattern key does not resolve here');
  const { createAi } = await import('./ai.js');
  const seen = [];
  const ai = createAi({ config: cfg, env: {}, notify: () => {}, fetchImpl: async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify({ data: [{ id: 'llama3.2' }] }), { status: 200 });
  } });
  cfg.setProbeHandler((op, id) => ai.runCheck(op, id));
  await cfg.handleFrame({ type: 'config_ai_probe', op: 'detect', id: 'local', nonce: 'n-ai' });
  assert.deepEqual(seen, [{ url: 'http://10.0.0.5:11434/v1/models', auth: 'Bearer sk-local-stored-key-5555' }]);
  const rep = api.calls.find((c) => c.url.endsWith('/config/report') && c.body.reply);
  assert.deepEqual(rep.body.reply, { nonce: 'n-ai', result: { ok: true, code: 'ok', models: ['llama3.2'] } });
  assert.ok(!JSON.stringify(rep.body).includes('stored-key'), 'the key itself was reported');
  api.calls.length = 0;
  await cfg.handleFrame({ type: 'config_ai_probe', op: 'test', id: 'helpdesk.answer', nonce: 'n-2' });
  assert.deepEqual(api.calls.find((c) => c.body && c.body.reply).body.reply, { nonce: 'n-2', result: { ok: false, code: 'off' } });
  api.calls.length = 0;
  await cfg.handleFrame({ type: 'config_ai_probe', op: 'rm -rf', id: 'x', nonce: 'n-3' });
  assert.equal(api.calls.length, 0, 'an unknown op was run');
});

test('a missing or malformed required install value is a boot problem', () => {
  const none = createInstanceConfig({ env: BASE, log: quiet }).bootProblems();
  assert.deepEqual(none, ['site.name is required — set SITE_NAME in .env', 'site.origin is required — set SITE_ORIGIN in .env']);
  const bad = createInstanceConfig({ env: { ...BASE, SITE_NAME: 'Example', SITE_ORIGIN: 'example.tv' }, log: quiet }).bootProblems();
  assert.equal(bad.length, 1);
  assert.match(bad[0], /^site\.origin: SITE_ORIGIN: not a URL/);
  assert.deepEqual(createInstanceConfig({ env: { ...BASE, SITE_NAME: 'Example', SITE_ORIGIN: 'https://example.tv' }, log: quiet }).bootProblems(), []);
});

test('a stored credential stream-api could not decrypt is an ERROR here, not the default', async () => {
  const api = stubApi();
  const orig = api;
  const f = async (url, init) => (String(url).includes('/config/secrets')
    ? { ok: true, status: 200, json: async () => ({ values: {}, unreadable: ['openai.apiKey'] }) }
    : orig(url, init));
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: f, log: quiet });
  await cfg.load();
  const r = cfg.resolve('openai.apiKey');
  assert.equal(r.value, null);
  assert.match(r.error, /cannot be read/);
  const envWins = createInstanceConfig({ env: { ...BASE, OPENAI_API_KEY: 'sk-env-000000000000' }, fetchImpl: f, log: quiet });
  await envWins.load();
  assert.equal(envWins.resolve('openai.apiKey').source, 'env');
});

test('the config socket authenticates with the bearer secret (internal frames only reach such sockets)', async () => {
  const made = [];
  class FakeWs { constructor(url, opts) { made.push({ url, opts }); } on() {} close() {} }
  const cfg = createInstanceConfig({ env: { ...BASE, STREAM_WS_URL: 'ws://api.test' }, fetchImpl: stubApi(), WebSocketImpl: FakeWs, log: quiet });
  await cfg.start();
  cfg.stop();
  assert.equal(made[0].opts.headers.Authorization, 'Bearer s3cret');
});

test('content (prompts, facts, the behavior file) arrives with the layer and a content frame re-reads it', async () => {
  let content = { 'helpdesk.facts': { body: 'v1', updatedBy: 'x', updatedAt: 'y' } };
  const base = stubApi();
  const f = async (url, init) => (String(url).endsWith('/content')
    ? { ok: true, status: 200, json: async () => ({ content }) }
    : base(url, init));
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: f, log: quiet });
  let loads = 0;
  cfg.onLoad(() => { loads++; });
  assert.equal(cfg.content('helpdesk.facts'), null, 'nothing before the first load');
  await cfg.load();
  assert.equal(cfg.content('helpdesk.facts'), 'v1');
  assert.equal(cfg.content('prompt.helpdesk.answer'), null);
  content = { 'prompt.helpdesk.answer': { body: 'mine', updatedBy: 'x', updatedAt: 'y' } };
  await cfg.handleFrame({ type: 'config_content_changed', keys: ['prompt.helpdesk.answer'] });
  assert.equal(cfg.content('prompt.helpdesk.answer'), 'mine');
  assert.equal(cfg.content('helpdesk.facts'), null, 'a reverted body is gone, not kept');
  assert.equal(loads, 2, 'every successful load tells the listeners');
});

test('a failed content read keeps the settings (and the last content) — it never costs the credentials', async () => {
  let contentUp = true;
  const base = stubApi({ secrets: { 'openai.apiKey': 'sk-db-0000000000001234' } });
  const f = async (url, init) => {
    if (String(url).endsWith('/content')) {
      return contentUp ? { ok: true, status: 200, json: async () => ({ content: { 'helpdesk.facts': { body: 'kept' } } }) } : { ok: false, status: 500, json: async () => ({}) };
    }
    return base(url, init);
  };
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: f, log: quiet });
  assert.equal(await cfg.load(), true);
  contentUp = false;
  assert.equal(await cfg.load(), true, 'the settings load failed because content did');
  assert.equal(cfg.state().loaded, true);
  assert.equal(cfg.get('openai.apiKey'), 'sk-db-0000000000001234');
  assert.equal(cfg.content('helpdesk.facts'), 'kept', 'the last content set was dropped');
  assert.equal(cfg.contentLoaded(), true, 'content read once stays known through a later failed read');
  cfg.stop();
});

test('contentLoaded: false until a content read succeeds, even when the settings themselves loaded', async () => {
  let contentUp = false;
  const base = stubApi();
  const f = async (url, init) => (String(url).endsWith('/content')
    ? (contentUp ? { ok: true, status: 200, json: async () => ({ content: {} }) } : { ok: false, status: 503, json: async () => ({}) })
    : base(url, init));
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: f, log: quiet });
  assert.equal(cfg.contentLoaded(), false);
  assert.equal(await cfg.load(), true);
  assert.equal(cfg.contentLoaded(), false, 'a failed first content read reads as an empty content set');
  contentUp = true;
  await cfg.load();
  assert.equal(cfg.contentLoaded(), true, 'an EMPTY content set, read successfully, is known');
  cfg.stop();
});

test('config_ai_probe op embed: the memory panel\'s probe runs HERE on a candidate connection + model, with dimensions when asked', async () => {
  const api = stubApi({ secrets: { 'openai.apiKey': 'sk-openai-ingest-key-000' } });
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: api, log: quiet });
  await cfg.load();
  const { createAi } = await import('./ai.js');
  const seen = [];
  const ai = createAi({ config: cfg, env: {}, notify: () => {}, fetchImpl: async (url, init) => {
    const b = JSON.parse(init.body);
    seen.push({ url: String(url), model: b.model, dimensions: b.dimensions ?? null });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: b.dimensions || 3072 }, () => 0.1) }] }), { status: 200 });
  } });
  cfg.setProbeHandler((op, id, opts) => ai.runCheck(op, id, opts));
  await cfg.handleFrame({ type: 'config_ai_probe', op: 'embed', id: 'openai', model: 'text-embedding-3-large', nonce: 'e-1' });
  await cfg.handleFrame({ type: 'config_ai_probe', op: 'embed', id: 'openai', model: 'text-embedding-3-large', dimensions: 1536, nonce: 'e-2' });
  assert.deepEqual(seen, [
    { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-large', dimensions: null },
    { url: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-large', dimensions: 1536 },
  ]);
  const replies = api.calls.filter((c) => c.body && c.body.reply).map((c) => [c.body.reply.nonce, c.body.reply.result.dim]);
  assert.deepEqual(replies, [['e-1', 3072], ['e-2', 1536]]);
});

test('a restart-applied key is reported as the first load took it — what this process runs — until the restart', async () => {
  const values = { 'modules.youtube': false };
  const api = stubApi({ values });
  const cfg = createInstanceConfig({ env: BASE, fetchImpl: api, log: quiet });
  await cfg.load();
  assert.equal(cfg.statusReport()['modules.youtube'].display, false);
  values['modules.youtube'] = true;
  await cfg.load();
  assert.equal(cfg.get('modules.youtube'), true, 'the layer holds the saved value');
  assert.equal(cfg.statusReport()['modules.youtube'].display, false, 'the report says the old value still runs');
});
