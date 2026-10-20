// stream-api's AI wrapper (ai.js) against a REAL Postgres: a reporting process's plugin slots and
// usage land in site.ai_slots / site.ai_usage through the real pg driver, a forged or buggy
// report cannot store anything outside the fixed shape, and GET /ai/routes shows every slot.
//
// Fixtures: slot ids `zz…`, plugins `zz-test` / `zztest`; removed before and after.
//
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test ai.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createAi } = require('./ai');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const fakeConfig = (values = {}) => ({ get: (k) => (k in values ? values[k] : null) });

test('a plugin cannot take a product slot id', () => {
  const ai = createAi({ config: fakeConfig(), env: {} });
  assert.throws(() => ai.registerSlots('x', [{ id: 'embeddings', kind: 'embed', label: 'mine' }]), /refused/);
});

test('a plugin slot\'s declared prompts: only its own keys, fixed shape, known to the content writer', async () => {
  const ai = createAi({ config: fakeConfig(), env: {}, log: quiet });
  const long = 'x'.repeat(16001);
  await ai.acceptReport('stream-ingest', {
    slots: [{
      id: 'zz.chat', kind: 'chat', owner: 'plugin:zztest', label: 'ZZ chat',
      prompts: [
        { key: 'zztest.voice', label: 'Voice', help: 'how it talks', defaultPrompt: '  Exact default.\n', extra: 'dropped' },
        { key: 'zztest.voice', label: 'Twice', defaultPrompt: 'second copy' },          // duplicate: dropped
        { key: 'other.voice', label: 'Not mine', defaultPrompt: 'x' },                    // another plugin's id: dropped
        { key: 'helpdesk.answer', label: 'Hijack', defaultPrompt: 'x' },                  // a product slot id: dropped
        { key: 'zztest.empty', label: 'Empty', defaultPrompt: '   ' },                   // no default: dropped
        { key: 'zztest.long', label: 'Long', defaultPrompt: long },                      // over the cap: dropped
        { key: 'zztest.nolabel', defaultPrompt: 'x' },                                   // no label: dropped
      ],
    }],
  });
  assert.equal(ai.promptKnown('zztest.voice'), true);
  for (const k of ['other.voice', 'helpdesk.answer', 'zztest.empty', 'zztest.long', 'zztest.nolabel', 'zz.chat']) {
    assert.equal(ai.promptKnown(k), false, `${k} became a known prompt`);
  }
  const mine = createAi({ config: fakeConfig(), env: {} });
  mine.registerSlots('zzown', [{ id: 'zz.own', kind: 'chat', label: 'Own', prompts: [{ key: 'zzown.a', label: 'A', defaultPrompt: 'a' }] }]);
  assert.equal(mine.promptKnown('zzown.a'), true, 'this process\'s own plugin prompt is not known');
});

test('a failing slot: health in the view, ONE ops alert per episode, none for the embedder', async () => {
  const sent = [];
  const fetchImpl = async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key sk-ECHO' } }), { status: 401 });
  const ai = createAi({
    config: fakeConfig({ 'anthropic.apiKey': 'ak-test', 'openai.apiKey': 'ok-test', 'ai.embeddings': { connection: 'openai', model: 'm-embed' } }),
    env: {}, fetchImpl, log: quiet, notify: (...a) => sent.push(a),
  });
  ai.registerSlots('zz-test', [{ id: 'zz.chat', kind: 'chat', label: 'ZZ chat', defaultRoute: { connection: 'anthropic', model: 'claude-x' } }]);
  await assert.rejects(ai.chat('zz.chat', { messages: [] }), (e) => e.code === 'key_rejected');
  await assert.rejects(ai.chat('zz.chat', { messages: [] }), (e) => e.code === 'key_rejected');
  assert.equal(sent.length, 1, 'a rejected key alarmed more than once');
  assert.equal(sent[0][0], 'ai.zz.chat.failing');
  assert.ok(!JSON.stringify(sent).includes('ECHO'), 'provider text reached the alert');
  await assert.rejects(ai.embed(['x']), (e) => e.code === 'key_rejected');
  assert.equal(sent.length, 1, 'the embedder alarmed here too — memory raises its own one alarm');
  const v = await ai.routesView();
  const row = v.slots.find((s) => s.id === 'embeddings');
  assert.equal(row.health['stream-api'].status, 'failing');
  assert.equal(row.health['stream-api'].lastCode, 'key_rejected');
  assert.equal(v.usage.slots.embeddings.errors, 1, "today's usage includes this process's unflushed counts");
});

test('AI reports and routes, against a real database', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 2 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.ai_slots WHERE slot_id LIKE 'zz%'`);
    await pool.query(`DELETE FROM site.ai_usage WHERE slot_id LIKE 'zz%'`);
  };
  t.after(async () => { await clean(); await pool.end(); });
  await clean();

  let now = Date.parse('2026-10-07T12:00:00Z');
  const ai = createAi({ config: fakeConfig({ 'ai.mode': 'simple' }), env: {}, now: () => now, log: quiet });
  await ai.start({ pool });

  const report = {
    slots: [
      { id: 'zz.chat', kind: 'chat', owner: 'plugin:zztest', needs: ['tools', 'teleport'], label: 'ZZ chat', description: 'a test slot',
        envModel: ['ZZ_MODEL'], envConnection: 'anthropic', defaultRoute: { connection: 'anthropic', model: 'm1' }, apiKey: 'sk-should-not-survive',
        prompts: [{ key: 'zztest.voice', label: 'Voice', help: 'how it talks', defaultPrompt: 'Exact default.' }] },
      { id: 'helpdesk.answer', kind: 'chat', owner: 'plugin:zz-test', label: 'hijack' },          // a product id: dropped
      { id: 'zz.bad id', kind: 'chat', owner: 'plugin:zz-test', label: 'x' },                     // malformed: dropped
      { id: 'zz.noowner', kind: 'chat', owner: 'product', label: 'x' },                           // not a plugin owner: dropped
    ],
    routes: {
      'zz.chat': { enabled: true, connection: 'anthropic', model: 'm1', source: 'env', envName: 'ZZ_MODEL', baseUrl: 'https://evil.example' },
      'helpdesk.answer': { enabled: true, connection: 'anthropic', model: 'claude-haiku-4-5', source: 'db', envName: null },
      'embeddings': { enabled: true, connection: 'openai', model: '<script>', source: 'db' },
    },
    locks: { embeddings: 'owned by the plugin' },
    providesBot: 'ZZ bot',
    usage: [
      { day: '2026-10-07', slot: 'zz.chat', connection: 'anthropic', model: 'm1', calls: 3, errors: 1, unchecked: 0, in: 100, out: 20 },
      { day: '2026-10-07', slot: 'zz.chat', connection: 'anthropic', model: 'm1', calls: -5, errors: 0, unchecked: 0, in: 1e12, out: 0 },
      { day: '1999-01-01', slot: 'zz.chat', connection: 'anthropic', model: 'm1', calls: 7, errors: 0, unchecked: 0, in: 0, out: 0 },
    ],
  };
  await ai.acceptReport('stream-ingest', report);
  await ai.acceptReport('stream-ingest', { ...report, usage: [report.usage[0]] });

  const slots = (await pool.query(`SELECT * FROM site.ai_slots WHERE slot_id LIKE 'zz%' OR slot_id = 'helpdesk.answer'`)).rows;
  assert.deepEqual(slots.map((s) => s.slot_id), ['zz.chat']);
  assert.deepEqual(slots[0].needs, ['tools'], 'an unknown need was stored');
  assert.equal(slots[0].provides_bot, 'ZZ bot');
  assert.equal(slots[0].package, 'stream-ingest');
  assert.doesNotMatch(JSON.stringify(slots), /sk-should|evil/);

  const usage = (await pool.query(`SELECT calls, errors, tokens_in, tokens_out, day::text FROM site.ai_usage WHERE slot_id = 'zz.chat'`)).rows;
  assert.deepEqual(usage, [{ calls: 6, errors: 2, tokens_in: '200', tokens_out: '40', day: '2026-10-07' }],
    'usage did not ADD across reports, or a negative/huge/stale row got in');

  const view = await ai.routesView();
  const zz = view.slots.find((s) => s.id === 'zz.chat');
  assert.deepEqual(zz.routes['stream-ingest'], { enabled: true, connection: 'anthropic', model: 'm1', source: 'env', envName: 'ZZ_MODEL' });
  assert.equal(zz.running, true);
  assert.deepEqual(zz.prompts, [{ key: 'zztest.voice', label: 'Voice', help: 'how it talks', defaultPrompt: 'Exact default.' }],
    'the page cannot list the plugin\'s prompts');
  const hd = view.slots.find((s) => s.id === 'helpdesk.answer');
  assert.equal(hd.owner, 'product');
  assert.equal(hd.routes['stream-ingest'].model, 'claude-haiku-4-5');
  assert.deepEqual(hd.routes['stream-api'], { enabled: false, reason: 'off' }, 'this process has no helpdesk row in the fake config');
  assert.deepEqual(view.slots.find((s) => s.id === 'embeddings').routes['stream-ingest'], { enabled: false, reason: 'not_configured' }, 'a malformed model was shown');
  assert.equal(view.slots.find((s) => s.id === 'embeddings').lockedBy, 'owned by the plugin');
  assert.doesNotMatch(JSON.stringify(view), /evil|sk-|apiKey|https?:/);

  now += 11 * 60_000;
  assert.equal((await ai.routesView()).slots.find((s) => s.id === 'zz.chat').running, false, 'a silent package still reads as running');
  await ai.stop();
});
