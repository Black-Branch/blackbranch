// webhooks.js + money.js /alert: WHEN each provider is acknowledged and WHEN its replay guard
// remembers an event, relative to the ledger's answer (review round 4, L1 criterion 2).
// alert.dispatch holds until the ledger answers, so "dispatch resolved" is "the ledger answered".
//   • Ko-fi / Patreon: the 200 goes out only after dispatch resolved; a throw answers 500 (they
//     redeliver a non-2xx) and the id is NOT remembered, so the redelivery runs again.
//   • Streamlabs: no ack exists; a failed dispatch is not remembered, so the next reconnect's
//     replay brings it back.
//   • /alert: a delivery of an id still in flight waits for the first, never answers early.
// Also: Ko-fi Shop Order / Commission are celebrated and never credited.
// Run: node --test webhooks-ack-order.test.js

'use strict';
process.env.KOFI_VERIFICATION_TOKEN = 'kofi-test-token';
process.env.PATREON_WEBHOOK_SECRET = 'patreon-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { registerPaymentWebhooks, createStreamlabsHandler, createReplayGuard } = require('./webhooks.js');
const { createAlert } = require('./alert');
const { createMoney } = require('./money');
const economics = require('./economics');

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

function rig(dispatch) {
  const routes = {};
  registerPaymentWebhooks({ app: { post: (p, h) => { routes[p] = h; } }, wrap: (fn) => fn, alert: { dispatch } });
  const res = () => {
    const r = { statusCode: null, sentAt: null, status(c) { this.statusCode = c; return this; },
      json(b) { if (this.statusCode == null) this.statusCode = 200; this.body = b; this.sentAt = order.length; order.push(`ack:${this.statusCode}`); return this; } };
    return r;
  };
  const order = [];
  const kofi = async (data) => {
    const r = res();
    await quietly(() => routes['/webhook/kofi']({ body: { data: JSON.stringify({ verification_token: 'kofi-test-token', ...data }) } }, r));
    return r;
  };
  const patreon = async (body) => {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = crypto.createHmac('md5', 'patreon-test-secret').update(raw).digest('hex');
    const headers = { 'x-patreon-signature': sig, 'x-patreon-event': 'members:pledge:create' };
    const r = res();
    await quietly(() => routes['/webhook/patreon']({ body, rawBody: raw, get: (h) => headers[h.toLowerCase()] }, r));
    return r;
  };
  return { kofi, patreon, order };
}

const KOFI = { kofi_transaction_id: 'tx-a', from_name: 'casey', amount: '5.00', currency: 'USD', type: 'Donation' };

test('Ko-fi is acknowledged only AFTER dispatch (the ledger) has answered', async () => {
  let r;
  const order = [];
  const h = rig(async () => { order.push('dispatch-start'); await new Promise((x) => setTimeout(x, 20)); order.push('dispatch-done'); });
  r = await h.kofi(KOFI);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(order, ['dispatch-start', 'dispatch-done']);
  assert.equal(h.order[0], 'ack:200');
  // the ack happened after dispatch completed: dispatch-done was recorded before json() ran
  assert.ok(order.indexOf('dispatch-done') === 1);
});

test('a Ko-fi dispatch that throws answers 500 and is NOT remembered — the redelivery runs again', async () => {
  let calls = 0;
  const h = rig(async () => { calls++; if (calls === 1) throw new Error('db down'); });
  const first = await h.kofi(KOFI);
  assert.equal(first.statusCode, 500, 'a failed event was acknowledged — Ko-fi would never redeliver it');
  const second = await h.kofi(KOFI);
  assert.equal(second.statusCode, 200);
  assert.equal(calls, 2, 'the redelivery was swallowed by the replay guard');
  const third = await h.kofi(KOFI);
  assert.equal(third.statusCode, 200);
  assert.equal(calls, 2, 'a processed event ran a second time');
});

test('a Ko-fi redelivery while the first is still in flight waits for it — never acked early, never run twice', async () => {
  let release;
  const gate = new Promise((x) => { release = x; });
  let calls = 0;
  const h = rig(async () => { calls++; await gate; });
  const a = h.kofi(KOFI);
  const b = h.kofi(KOFI);
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(h.order.length, 0, 'a delivery was acknowledged before the ledger answered');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual([ra.statusCode, rb.statusCode], [200, 200]);
});

test('Patreon: a throw answers 500 and the redelivery runs again', async () => {
  let calls = 0;
  const h = rig(async () => { calls++; if (calls === 1) throw new Error('db down'); });
  const body = { data: { id: 'm1', attributes: { will_pay_amount_cents: 500, currency: 'USD' } }, included: [] };
  assert.equal((await h.patreon(body)).statusCode, 500);
  assert.equal((await h.patreon(body)).statusCode, 200);
  assert.equal(calls, 2);
});

test('Streamlabs: a failed dispatch is forgotten, so the reconnect replay dispatches it again', async () => {
  let calls = 0;
  const handler = createStreamlabsHandler({ alert: { dispatch: async () => { calls++; if (calls === 1) throw new Error('boom'); } } });
  const ev = { type: 'donation', message: [{ _id: 'sl-x', name: 'casey', amount: '5', currency: 'USD' }] };
  await quietly(async () => {
    handler(ev);
    await new Promise((x) => setTimeout(x, 10));
    handler(ev); // the reconnect replay
    await new Promise((x) => setTimeout(x, 10));
    handler(ev); // and again, after a success
    await new Promise((x) => setTimeout(x, 10));
  });
  assert.equal(calls, 2, 'a failed Streamlabs donation was remembered as done (or a done one re-ran)');
});

test('the replay guard remembers a key only after success', async () => {
  const g = createReplayGuard();
  await assert.rejects(g.run('k', async () => { throw new Error('x'); }));
  const ok = await g.run('k', async () => 'done');
  assert.deepEqual(ok, { replay: false, result: 'done' });
  assert.deepEqual(await g.run('k', async () => 'again'), { replay: true });
});

// ── /alert ──────────────────────────────────────────────────────────────────

function alertRoute(dispatch) {
  const routes = {};
  const money = createMoney({ alert: { dispatch } });
  money.registerMoneyRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
    { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
  return async (body) => {
    const r = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/alert']({ body }, r);
    return r;
  };
}

test('/alert: a second delivery of an id in flight waits for the first and is answered deduped', async () => {
  let release;
  const gate = new Promise((x) => { release = x; });
  let calls = 0;
  const post = alertRoute(async () => { calls++; await gate; });
  const body = { platform: 'twitch', eventType: 'bits', bits: 100, eventId: 'twitch:e-1' };
  let answered = 0;
  const a = post(body).then((r) => { answered++; return r; });
  const b = post(body).then((r) => { answered++; return r; });
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(answered, 0, '/alert answered before the ledger did');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.deepEqual(ra.body, { ok: true });
  assert.deepEqual(rb.body, { ok: true, deduped: true });
});

test('/alert: a dispatch that throws is not remembered — the producer\'s retry runs it', async () => {
  let calls = 0;
  const post = alertRoute(async () => { calls++; if (calls === 1) throw new Error('boom'); });
  const body = { platform: 'twitch', eventType: 'bits', bits: 100, eventId: 'twitch:e-2' };
  await assert.rejects(post(body), /boom/); // wrap → 500 in production
  const again = await post(body);
  assert.deepEqual(again.body, { ok: true });
  assert.equal(calls, 2);
});

// ── Ko-fi purchases (owner decision): celebrated, never credited ──────────────

test('Ko-fi Shop Order and Commission are dispatched as purchases with a take-home of 0', async () => {
  const seen = [];
  const h = rig(async (x) => { seen.push(x); });
  await h.kofi({ ...KOFI, kofi_transaction_id: 'tx-shop', type: 'Shop Order', amount: '40.00' });
  await h.kofi({ ...KOFI, kofi_transaction_id: 'tx-comm', type: 'Commission', amount: '90.00' });
  assert.deepEqual(seen.map((d) => d.eventType), ['shop-order', 'commission']);
  for (const d of seen) {
    assert.equal(economics.takeHome('kofi', d.eventType, d), 0, `${d.eventType} credited take-home`);
    assert.equal(economics.unpricedNative('kofi', d.eventType, { ...d, currency: 'XXX' }), null, `${d.eventType} could land in unpriced_support`);
  }
  assert.ok(economics.takeHome('kofi', 'donation', { amount: 40, currency: 'USD' }) > 0, 'positive control: a donation still credits');
});

test('a Ko-fi Shop Order through the real alert path celebrates and writes no ledger row and no bar credit', async () => {
  const n = { show: 0, ledger: 0, bar: 0 };
  const alert = createAlert({
    broadcast: (m) => { if (m.type === 'showAlert') n.show++; }, bufferPush: () => {},
    obs: null, tts: null, lights: null,
    supportBar: { add: () => { n.bar++; return { deltaSeconds: 1 }; } },
    logSupport: async () => { n.ledger++; return { duplicate: false }; },
    logUnpriced: async () => { n.ledger++; return { duplicate: false }; },
  });
  await quietly(() => alert.dispatch({ platform: 'kofi', eventType: 'shop-order', username: 'casey', amount: 40, currency: 'USD', eventId: 'tx-shop-2' }));
  assert.deepEqual(n, { show: 1, ledger: 0, bar: 0 });
});
