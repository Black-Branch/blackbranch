// Speech is a SETTING, not an env-only switch: an env-only gate and voices read from env at require
// time are in neither the schema nor the bundle's compose, so paid read-aloud, /speak and alert
// narration would be dead on every install. So:
//   • tts.enabled (env ALERT_TTS_ENABLED only through the schema's env fallback) is read through
//     the settings layer, restart-applied: what the FIRST successful load resolved, never later;
//   • tts.voiceCasual / tts.voiceLoud are read per run;
//   • GET /tts/status answers { enabled, keySet, voiceSet, sink } and never a value.
//
// This file drives the real process singleton (each test FILE is its own process under node --test),
// with a fake pool standing in for site.instance_config.
//
// Run: node --test tts-settings.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

for (const k of ['ALERT_TTS_ENABLED', 'ELEVENLABS_VOICE_CASUAL', 'ELEVENLABS_VOICE_LOUD', 'ELEVENLABS_API_KEY', 'TTS_SINK', 'INSTANCE_MASTER_KEY']) delete process.env[k];

const { instanceConfig } = require('./instance-config');
const tts = require('./tts');
const { createMoney } = require('./money');

/** site.instance_config as a fake pool: `rows` is what the next load reads. */
function settingsPool(rows) {
  const state = { rows };
  return {
    state,
    query: async (sql) => {
      if (/FROM site\.instance_config/.test(sql)) return { rows: state.rows.map(([key, value]) => ({ key, value, updated_by: 'test', updated_at: new Date() })) };
      return { rows: [] };
    },
  };
}

function statusRoute() {
  const routes = {};
  createMoney({ tts, ttsEnabled: tts.enabled }).registerMoneyRoutes(
    { get: (p, ...h) => { routes[p] = h.at(-1); }, post: () => {} },
    { requireInternal: (q, s, n) => n(), wrap: (fn) => fn },
  );
  return () => {
    let body = null;
    routes['/tts/status']({}, { json(b) { body = b; } });
    return body;
  };
}


test('a fresh install speaks nothing: tts.enabled is off before and after the settings load', async () => {
  assert.equal(tts.enabled(), false, 'speech is on with nothing set');
  const status = statusRoute();
  assert.deepEqual(status(), { enabled: false, keySet: false, voiceSet: false, sink: null });
});

test('tts.enabled saved in the Admin Panel turns speech on at the first load, and a later save waits for the restart', async () => {
  const pool = settingsPool([['tts.enabled', true], ['tts.voiceCasual', 'voice-casual-id']]);
  const origWarn = console.warn; console.warn = () => {};
  try {
    instanceConfig.init({ pool, notify: () => {} });
    await instanceConfig.loaded;
  } finally { console.warn = origWarn; }
  assert.equal(tts.enabled(), true, 'the stored tts.enabled did not switch speech on at the first load');

  // A second save (the switch turned off) is restart-applied: this process keeps speaking until it
  // restarts, which is what the Admin Panel's "pending restart" says.
  pool.state.rows = [['tts.enabled', false], ['tts.voiceCasual', 'voice-casual-id']];
  await instanceConfig.load();
  assert.equal(instanceConfig.get('tts.enabled'), false, 'premise: the layer re-read the switch');
  assert.equal(tts.enabled(), true, 'a saved change applied without a restart — the panel would say "pending" while it ran');
});

test('the voices come from tts.voiceCasual / tts.voiceLoud, read per run (no restart)', async () => {
  // Stored: casual only (previous test). The loud run falls back to it.
  assert.equal(tts.voiceFor(false), 'voice-casual-id');
  assert.equal(tts.voiceFor(true), 'voice-casual-id', 'a loud run with no loud voice must use the main one');
  process.env.ELEVENLABS_VOICE_LOUD = 'voice-loud-id';
  try {
    assert.equal(tts.voiceFor(true), 'voice-loud-id', 'the loud voice was not read at call time');
    assert.equal(tts.voiceFor(false), 'voice-casual-id');
  } finally { delete process.env.ELEVENLABS_VOICE_LOUD; }
});

test('GET /tts/status: enabled, keySet, voiceSet, sink — and never the key or a voice id', async () => {
  process.env.ELEVENLABS_API_KEY = 'sk_live_tts_status_never_shown_1234';
  process.env.TTS_SINK = 'speech_sink';
  try {
    const body = statusRoute()();
    assert.deepEqual(body, { enabled: true, keySet: true, voiceSet: true, sink: 'speech_sink' });
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes('sk_live') && !wire.includes('voice-casual-id'), `a value reached the status: ${wire}`);
  } finally { delete process.env.ELEVENLABS_API_KEY; delete process.env.TTS_SINK; }
  const off = statusRoute()();
  assert.equal(off.keySet, false, 'keySet with no key');
  assert.equal(off.sink, null);
});

test('money.js speaks a paid read-aloud only through ttsEnabled, and /speak answers "skipped" while it is off', async () => {
  const spoken = [];
  let on = false;
  const routes = {};
  const money = createMoney({
    tts: { speak: (t) => { spoken.push(t); return Promise.resolve(true); } }, ttsEnabled: () => on,
    cleanForTTS: (t) => t,
  });
  money.registerMoneyRoutes(
    { get: () => {}, post: (p, ...h) => { routes[p] = h.at(-1); } },
    { requireInternal: (q, s, n) => n(), requireSecret: (q, s, n) => n(), wrap: (fn) => fn },
  );
  const post = async (body) => { let out = null; await routes['/speak']({ body }, { json(b) { out = b; return this; }, status() { return this; } }); return out; };
  assert.deepEqual(await post({ text: 'hello' }), { ok: true, skipped: 'tts disabled' });
  assert.equal(spoken.length, 0);
  on = true;
  assert.deepEqual(await post({ text: 'hello' }), { ok: true });
  assert.equal(spoken.length, 1, 'switched on, /speak did not speak');
});
