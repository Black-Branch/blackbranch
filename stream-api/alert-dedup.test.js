// POST /alert idempotency — the receiving half of the ingest retry contract.
//
// With a single attempt, a sub/cheer/superchat landing during a stream-api
// restart (the drain runs up to 10s) or one ECONNRESET is gone forever: no
// support_events row, no bar credit, no on-stream alert. So the producer
// retries, boundedly — and a retry on the MONEY route is only legal because
// this dedup makes a duplicate delivery a no-op.
//
// Keyed on platform + the producer's eventId. Fail-open when absent: the
// webhook producers (Ko-fi/Patreon/Streamlabs) dispatch in-process and never
// touch this route, and an old producer without ids must keep working — an
// alert dropped by an over-eager guard is a viewer's moment lost.
//
// Run: node --test alert-dedup.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney } = require('./money.js');

// ── route harness (alert-validation.test.js's, unchanged) ───────────────────

function routeHarness() {
  const dispatched = [];
  const alert = { dispatch: async (input) => { dispatched.push(input); return { ok: true }; } };
  const routes = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    app[verb] = (p, ...rest) => routes.set(`${verb.toUpperCase()} ${p}`, rest[rest.length - 1]);
  }
  const noop = () => {};
  const money = createMoney({
    pool: { query: async () => ({ rows: [] }) },
    economics: require('./economics.js'),
    alert,
    supportBar: { add: () => ({ deltaSeconds: 0 }), getTotal: () => 0, reset: noop },
    timer: { snapshot: () => ({ locked: false }), addMoney: noop, adjust: noop, set: noop,
             control: noop, setConfig: noop, config: () => ({}), parseDuration: () => 0 },
    tts: null, sounds: { manifest: () => [] }, cleanForTTS: (s) => s,
    recordSupport: async () => 1, persistEventCard: async () => 1,
    maskBlacklist: (s) => s, broadcast: noop, bufferPush: noop, bufferReplace: noop,
    ttsEnabled: () => false,
  });
  money.registerMoneyRoutes(app, { requireInternal: (_q, _s, n) => n && n(), wrap: (fn) => fn });
  const handler = routes.get('POST /alert');
  assert.ok(handler, 'POST /alert is no longer registered');

  return {
    dispatched,
    async post(body) {
      let payload; let status = 200;
      const res = { json: (b) => { payload = b; return res; }, status: (c) => { status = c; return res; } };
      await handler({ body }, res);
      return { status, payload };
    },
  };
}

const SUB = { platform: 'twitch', eventType: 'sub', username: 'a', userId: '1',
  tier: '1000', months: 1, message: '', label: 'subscribed' };

test('a re-delivered eventId dispatches ONCE and acks as a duplicate', async () => {
  const h = routeHarness();
  const first = await h.post({ ...SUB, eventId: 'twitch:msg-1' });
  const second = await h.post({ ...SUB, eventId: 'twitch:msg-1' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'a duplicate must ack 200 — the producer treats it as delivered');
  assert.equal(second.payload.deduped, true);
  assert.equal(h.dispatched.length, 1,
    'the duplicate reached dispatch — a retried sub would ring twice and double-credit the bar');
});

test('distinct eventIds both dispatch', async () => {
  const h = routeHarness();
  await h.post({ ...SUB, eventId: 'twitch:msg-1' });
  await h.post({ ...SUB, eventId: 'twitch:msg-2' });
  assert.equal(h.dispatched.length, 2,
    'two different paid events were collapsed into one — money silently dropped');
});

test('an alert with NO eventId is never deduped (fail-open)', async () => {
  const h = routeHarness();
  await h.post({ ...SUB });
  await h.post({ ...SUB });
  assert.equal(h.dispatched.length, 2,
    'two id-less alerts were deduped by their content — identical legitimate events ' +
    '(two anonymous $5 tips in a row) would silently drop the second');
});

test('the dedup key is scoped by platform, never trusting the producer to prefix', async () => {
  const h = routeHarness();
  await h.post({ ...SUB, eventId: 'e-1' });
  await h.post({ ...SUB, platform: 'kick', eventType: 'kicks', kicks: 100, label: 'sent 100 Kicks', eventId: 'e-1' });
  assert.equal(h.dispatched.length, 2,
    'the same raw id on two platforms collided — one platform\'s event ate the other\'s');
});
