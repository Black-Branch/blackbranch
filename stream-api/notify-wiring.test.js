// The three guards actually reach a human — driven through the REAL handlers.
//
// This is deliberately NOT a source scan for `notify(`. A scan would prove the
// call is written, not that it is reachable: the take-home clamp sits inside an
// `if` that only fires for an impossible producer value, and the /alert rejection
// only fires below a validation branch. Where a module is importable, a
// behavioural test beats a scan, and these are.
//
// The failure this protects against is specific and quiet: someone refactors a
// guard, keeps the console.warn, drops the notify, and the only symptom is that
// nothing ever arrives — which is indistinguishable from nothing going wrong.
//
// Run: node --test notify-wiring.test.js

'use strict';

// Before the requires. notify.js reads its config at module load, exactly like
// lights.js, so a test that sets these afterwards would silently test the
// disabled path — and every assertion below would pass on an empty array.
process.env.NTFY_WAKE_URL = 'https://ntfy.example/wake';
process.env.NTFY_QUIET_URL = 'https://ntfy.example/quiet';
process.env.OPS_NOTIFY_COOLDOWN_MS = '0';   // one push per event, so counts are readable

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlert } = require('./alert.js');
const { createMoney } = require('./money.js');
const { enabled, _resetNotifyState } = require('./notify.js');

const realFetch = global.fetch;

/** Run `fn` with ntfy stubbed; returns every publish it received. */
async function captureNotifications(fn) {
  _resetNotifyState();
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://ntfy.example/')) sent.push({
      url: String(url), title: init.headers.Title,
      priority: init.headers.Priority, message: String(init.body),
    });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await fn(); } finally { global.fetch = realFetch; }
  // notify() is fire-and-forget at every call site — give the microtask a turn.
  await new Promise((r) => setTimeout(r, 10));
  return sent;
}

test('premise: the notifier is configured in this process', () => {
  // Without this the three tests below would pass over an empty array forever.
  assert.equal(enabled(), true,
    'notify.js read its env as disabled — every assertion in this file is now vacuous');
});

// ── guard 1: the money path ─────────────────────────────────────────────────

function effectsHarness() {
  const frames = [];
  return {
    frames,
    alert: createAlert({
      broadcast: (f) => frames.push(f),
      bufferPush: () => {},
      supportBar: { add: () => ({ deltaSeconds: 1 }), getTotal: () => 0 },
      obs: null, lights: null, tts: null,
      logSupport: async () => 1,
      persistCard: async () => 1,
      maskBlacklist: (s) => s,
      timerLocked: () => false,
    }),
  };
}

test('a clamped take-home notifies, marked critical, with no payload values', async () => {
  const h = effectsHarness();
  const sent = await captureNotifications(() =>
    h.alert.fireStreamEffects({ platform: 'twitch', eventType: 'bits', bits: -100000, username: 'donor-name' }));

  assert.equal(sent.length, 1, 'the take-home clamp logged but did not notify');
  assert.match(sent[0].message, /twitch\/bits/, 'the notification must name the producer');
  assert.equal(sent[0].priority, '5',
    'money-path failures must survive Do Not Disturb — this one silently zeroed a donation');
  assert.equal(sent[0].url, 'https://ntfy.example/wake',
    'critical must land on the WAKE topic, not the tier that waits for morning');

  // The console.warn on this path deliberately carries `username` and the raw
  // value. A push renders on a lock screen, on a device that leaves the house.
  const text = `${sent[0].title} ${sent[0].message}`;
  assert.ok(!text.includes('donor-name'), 'a username reached a lock-screen notification');
  assert.ok(!text.includes('100000'), 'a raw payload value reached a lock-screen notification');
});

test('a normal donation notifies nothing at all', async () => {
  // The guard must be silent in the overwhelming common case, or it gets muted
  // and the clamped one above never gets read either.
  const h = effectsHarness();
  const sent = await captureNotifications(() =>
    h.alert.fireStreamEffects({ platform: 'kofi', eventType: 'donation', amount: 20, currency: 'USD', username: 'x' }));
  assert.deepEqual(sent, [], 'a healthy donation raised an operator notification');
});

// ── guard 2: the /alert envelope ────────────────────────────────────────────

function routeHarness() {
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
    timer: { snapshot: () => ({ locked: false }), addMoney: noop, adjust: noop, set: noop,
             control: noop, setConfig: noop, config: () => ({}), parseDuration: () => 0 },
    tts: null, sounds: { manifest: () => [] }, cleanForTTS: (s) => s,
    recordSupport: async () => 1, persistEventCard: async () => 1,
    maskBlacklist: (s) => s, broadcast: noop, bufferPush: noop, bufferReplace: noop,
    ttsEnabled: () => false,
  }).registerMoneyRoutes(app, { requireInternal: (_q, _s, n) => n && n(), wrap: (fn) => fn });

  const handler = routes.get('POST /alert');
  assert.ok(handler, 'POST /alert is no longer registered');
  return async (body) => {
    const res = { json: () => res, status: () => res };
    await handler({ body }, res);
  };
}

test('a rejected /alert envelope notifies', async () => {
  const post = routeHarness();
  const sent = await captureNotifications(() => post({ platform: '', eventType: '' }));
  assert.equal(sent.length, 1,
    'a producer sending incomplete alerts drops every alert it sends, and nobody is told');
  assert.equal(sent[0].priority, '5', 'an alert dropped is a viewer\'s moment lost');
  assert.equal(sent[0].url, 'https://ntfy.example/wake');
});

test('a well-formed /alert notifies nothing', async () => {
  const post = routeHarness();
  const sent = await captureNotifications(() =>
    post({ platform: 'twitch', eventType: 'sub', username: 'a', userId: '1', tier: '1000', months: 1 }));
  assert.deepEqual(sent, [], 'a valid alert raised an operator notification');
});

// ── notify failing must never reach the guard path ──────────────────────────

test('ntfy being down does not disturb the guard that called it', async () => {
  // The whole point: this module reports failures, so it runs when things are
  // already bad — including, plausibly, the network.
  const h = effectsHarness();
  _resetNotifyState();
  global.fetch = async () => { throw new Error('EHOSTUNREACH'); };
  try {
    const r = await h.alert.fireStreamEffects(
      { platform: 'twitch', eventType: 'bits', bits: -100000, username: 'x' });
    assert.equal(r.takeHome, 0, 'the clamp still has to work when the notifier cannot');
    // showAlert = "dispatch completed" (there is no money-bearing alert frame)
    assert.ok(h.frames.find((f) => f.type === 'showAlert'), 'the showAlert frame must still broadcast');
  } finally {
    global.fetch = realFetch;
  }
  await new Promise((r) => setTimeout(r, 10));
});
