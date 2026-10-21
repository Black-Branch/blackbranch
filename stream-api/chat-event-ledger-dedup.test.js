// /chat/event and the ledger's "already recorded".
// Run: node --test chat-event-ledger-dedup.test.js
//
// When fireStreamEffects reports that the ledger already holds a native money
// event (a retry that bridged a restart, so the in-memory spendOutcomes store
// was empty), no second card may be persisted or broadcast.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney } = require('./money.js');
const { buildEventCard } = require('./alert.js');

function chatEventHarness({ duplicate }) {
  const calls = [];
  const money = createMoney({
    pool: { query: async () => ({ rows: [{}], rowCount: 1 }) },
    economics: { stripeNet: (usd) => usd * 0.9, formatUSD: (u) => `$${u.toFixed(2)}` },
    alert: {
      buildEventCard,
      fireStreamEffects: async () => { calls.push('effects'); return { addedSeconds: 0, ...(duplicate ? { duplicate: true } : {}) }; },
      dispatch: async () => {},
    },
    supportBar: { add: () => ({ deltaSeconds: 0 }), reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return {}; } },
    tts: { speak: () => {} },
    sounds: { play: async () => true, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async () => { calls.push('persist'); return 99; },
    maskBlacklist: (t) => t,
    broadcast: (f) => calls.push(`broadcast:${f.type}`),
    bufferPush: () => calls.push('buffer'), bufferReplace: () => {},
    ttsEnabled: () => true,
  });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn }
  );
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/chat/event']({ body }, res);
    return res;
  };
  return { calls, post };
}

const DONATION = { kind: 'donation', donor: 'casey', amount: 500, currency: 'usd', message: 'hi', spendId: 'pay-1' };

test('/chat/event posts no second card when the ledger says the donation is already recorded', async () => {
  const h = chatEventHarness({ duplicate: true });
  const res = await h.post(DONATION);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deduped, true);
  assert.ok(!h.calls.includes('persist'), 'a duplicate persisted a second card row');
  assert.ok(!h.calls.includes('broadcast:message'), 'a duplicate broadcast a second card');
});

test('/chat/event still posts the card for a first delivery', async () => {
  const h = chatEventHarness({ duplicate: false });
  const res = await h.post(DONATION);
  assert.equal(res.statusCode, 200);
  assert.ok(h.calls.includes('persist'));
  assert.ok(h.calls.includes('broadcast:message'));
});

// A ledger that could not record the event is NOT effects_failed (which web reads as refund-legal):
// it answers 503 ledger_unavailable, releases the spendId so web's retry re-processes, and posts
// no card.
test('/chat/event answers 503 ledger_unavailable for a LedgerWriteError, and the retry re-processes', async () => {
  let failNext = true;
  const calls = [];
  const money = createMoney({
    pool: { query: async () => ({ rows: [{}], rowCount: 1 }) },
    economics: { stripeNet: (usd) => usd * 0.9, formatUSD: (u) => `$${u.toFixed(2)}` },
    alert: {
      buildEventCard,
      fireStreamEffects: async () => {
        calls.push('effects');
        if (failNext) { failNext = false; throw Object.assign(new Error('ledger write failed'), { code: 'LEDGER_WRITE_FAILED' }); }
        return { addedSeconds: 0 };
      },
      dispatch: async () => {},
    },
    persistEventCard: async () => { calls.push('persist'); return 99; },
    maskBlacklist: (t) => t, cleanForTTS: (t) => t,
    broadcast: (f) => calls.push(`broadcast:${f.type}`), bufferPush: () => {}, bufferReplace: () => {},
  });
  const routes = {};
  money.registerMoneyRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn });
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const q = console.error; console.error = () => {};
    try { await routes['/chat/event']({ body }, res); } finally { console.error = q; }
    return res;
  };
  const first = await post({ ...DONATION, spendId: 'pay-ledger' });
  assert.equal(first.statusCode, 503);
  assert.equal(first.body.error, 'ledger_unavailable', 'a ledger failure must not read as effects_failed (refund-legal)');
  assert.ok(!calls.includes('persist'), 'a card was posted for an event the ledger does not hold');
  const retry = await post({ ...DONATION, spendId: 'pay-ledger' });
  assert.equal(retry.statusCode, 200, 'the spendId stayed held — the retry could not re-process');
  assert.equal(calls.filter((c) => c === 'effects').length, 2);
});
