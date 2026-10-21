// POST /speak body validation. The route is the boundary between "the brain asked for a
// sound" and "the audio queue plays a file", so what it refuses matters: a body with
// neither text nor a clip is a caller bug, and pads are a sleep this process performs,
// which is a denial-of-service knob if it is not clamped.
//
// Deliberately NOT a new route — /speak grew fields. route-surface.snapshot.json is
// untouched and must stay that way.
//
// Run: node --test speak-route.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSpeakBody, createMoney } = require('./money.js');

test('a body with neither text nor a clip is a 400', () => {
  assert.deepEqual(parseSpeakBody({}), { error: 'text or noise required' });
  assert.deepEqual(parseSpeakBody({ text: '   ' }), { error: 'text or noise required' });
  assert.deepEqual(parseSpeakBody(null), { error: 'text or noise required' });
  // A malformed id is dropped, and with no text there is then nothing left to say.
  assert.deepEqual(parseSpeakBody({ noise: '../../etc/passwd' }), { error: 'text or noise required' });
});

test('plain text still works exactly as it did', () => {
  assert.deepEqual(parseSpeakBody({ text: 'yeah whatever man' }), { turn: { text: 'yeah whatever man' } });
});

test('a well-formed clip id rides through; a malformed one is dropped, not fatal', () => {
  const { turn } = parseSpeakBody({
    text: 'yeah whatever man',
    noiseBefore: 'clears_throat2.v0',
    noiseAfter: 'a/b/../c',
  });
  assert.equal(turn.noiseBefore, 'clears_throat2.v0');
  assert.equal(turn.noiseAfter, undefined, 'his line still goes out; the bad clip just does not');
});

test('pads are clamped — this process SLEEPS for them, and the queue is serialized', () => {
  assert.equal(parseSpeakBody({ text: 'x', padBeforeMs: 999999 }).turn.padBeforeMs, 2000);
  assert.equal(parseSpeakBody({ text: 'x', padAfterMs: -50 }).turn.padAfterMs, 0);
  assert.equal(parseSpeakBody({ text: 'x', padBeforeMs: 'soon' }).turn.padBeforeMs, 350);
  assert.equal(parseSpeakBody({ text: 'x', padAfterMs: null }).turn.padAfterMs, 250);
  assert.equal(parseSpeakBody({ text: 'x', padBeforeMs: 0 }).turn.padBeforeMs, 0, 'zero is a real value');
});

test('the route clamps with the QUEUE\'s rule, not a second copy of it', () => {
  // tts.js clamps again on its side, because /speak is not its only caller. Two clamps
  // are only safe while they are the same clamp — a route that accepted what the queue
  // then reinterpreted would make the pads it reports a lie.
  const { clampPadMs } = require('./tts.js');
  for (const raw of [999999, -50, 'soon', '350', ' 350 ', '', null, 0, 2000.4, true, []]) {
    assert.equal(
      parseSpeakBody({ text: 'x', padBeforeMs: raw }).turn.padBeforeMs,
      clampPadMs(raw, 350),
      `the route and the queue disagree about ${JSON.stringify(raw)}`,
    );
  }
});

// The real route, through the real factory — the same harness shape alert-validation.test.js
// uses, so this asserts the wiring and not a mirror of it.
function routeHarness({ ttsOn = true } = {}) {
  const spoken = [];
  const routes = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    app[verb] = (p, ...rest) => routes.set(`${verb.toUpperCase()} ${p}`, rest[rest.length - 1]);
  }
  const noop = () => {};
  const money = createMoney({
    pool: { query: async () => ({ rows: [] }) },
    economics: require('./economics.js'),
    alert: { dispatch: async () => ({ ok: true }) },
    supportBar: { add: () => ({ deltaSeconds: 0 }), getTotal: () => 0, reset: noop },
    timer: { snapshot: () => ({ night: { active: false } }), reset: noop, adjust: () => 0 },
    meter: { note: noop },
    tts: { speak: (turn) => { spoken.push(turn); } },
    sounds: { play: async () => false },
    cleanForTTS: (s) => s,
    persistEventCard: async () => null,
    maskBlacklist: (s) => s,
    broadcast: noop, bufferPush: noop, bufferReplace: noop,
    ttsEnabled: () => ttsOn,
  });
  // The invocation shape is copied verbatim from alert-validation.test.js — `wrap` has no
  // default in registerMoneyRoutes, so it is not optional here.
  money.registerMoneyRoutes(app, { requireInternal: (_q, _s, n) => n && n(), wrap: (fn) => fn });
  return { routes, spoken };
}

function resSpy() {
  const out = { code: 200, body: null };
  return {
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    out,
  };
}

test('the route hands the parsed turn to the queue, and refuses an empty one', async () => {
  const { routes, spoken } = routeHarness();
  const handler = routes.get('POST /speak');
  assert.ok(handler, 'POST /speak must still be registered — no new route, the same one');

  const good = resSpy();
  await handler({ body: { text: 'yeah whatever man', noiseBefore: 'clears_throat2.v0', padBeforeMs: 5000 } }, good, noopNext);
  assert.deepEqual(good.out.body, { ok: true });
  assert.deepEqual(spoken, [{ text: 'yeah whatever man', noiseBefore: 'clears_throat2.v0', padBeforeMs: 2000 }]);

  const bad = resSpy();
  await handler({ body: {} }, bad, noopNext);
  assert.equal(bad.out.code, 400);
});

function noopNext() {}

// ── The audio cue ──────────────────────────────────────────────
// This route answers the moment a turn is queued, so without `wait` the brain can only
// guess when the bot stopped talking. With `wait`, the answer comes when the audio has
// really finished — the queue's own definitive end — so the brain can time the next line
// off the real end. Callers that do not ask (donation alerts, paid TTS) are answered at once.
function waitHarness(played) {
  return routeHarnessWith((turn) => new Promise((resolve) => setTimeout(() => {
    if (played) Object.assign(turn, { startedAt: 1000, endedAt: 9000, synthMs: 420, quietBeforeMs: 2100 });
    resolve(played);
  }, 20)));
}
function routeHarnessWith(speak) {
  const routes = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    app[verb] = (p, ...rest) => routes.set(`${verb.toUpperCase()} ${p}`, rest[rest.length - 1]);
  }
  const noop = () => {};
  createMoney({
    pool: { query: async () => ({ rows: [] }) },
    economics: require('./economics.js'),
    alert: { dispatch: async () => ({ ok: true }) },
    supportBar: { add: () => ({ deltaSeconds: 0 }), getTotal: () => 0, reset: noop },
    timer: { snapshot: () => ({ night: { active: false } }), reset: noop, adjust: () => 0 },
    meter: { note: noop },
    tts: { speak },
    sounds: { play: async () => false },
    cleanForTTS: (s) => s,
    persistEventCard: async () => null,
    maskBlacklist: (s) => s,
    broadcast: noop, bufferPush: noop, bufferReplace: noop,
    ttsEnabled: () => true,
  }).registerMoneyRoutes(app, { requireInternal: (_q, _s, n) => n && n(), wrap: (fn) => fn });
  return routes.get('POST /speak');
}

test('with wait, the route answers when his audio has finished, with when it started and ended', async () => {
  const handler = waitHarness(true);
  const res = resSpy();
  await handler({ body: { text: 'yeah whatever man', wait: true } }, res, noopNext);
  assert.deepEqual(res.out.body, { ok: true, played: true, startedAt: 1000, endedAt: 9000, synthMs: 420, quietBeforeMs: 2100 });
});

test('with wait, a turn that played nothing says so', async () => {
  const handler = waitHarness(false);
  const res = resSpy();
  await handler({ body: { text: 'yeah whatever man', wait: true } }, res, noopNext);
  assert.deepEqual(res.out.body, { ok: true, played: false });
});

test('without wait the route still answers at once — alerts and paid TTS are unchanged', async () => {
  let resolved = false;
  const handler = routeHarnessWith(() => new Promise((r) => setTimeout(() => { resolved = true; r(true); }, 50)));
  const res = resSpy();
  await handler({ body: { text: 'yeah whatever man' } }, res, noopNext);
  assert.deepEqual(res.out.body, { ok: true });
  assert.equal(resolved, false, 'answered before the audio finished');
});

test('wait is a request flag, never part of the turn the queue plays', () => {
  assert.deepEqual(parseSpeakBody({ text: 'x', wait: true }), { turn: { text: 'x' } });
});
