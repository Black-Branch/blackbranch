// webhooks.js: Ko-fi privacy.
// Run: node --test webhooks-kofi-privacy.test.js
//
// Ko-fi sends `is_public: false` when the supporter asked to stay private.
// Ignored, their name and message would go to TTS, the overlay, the
// persisted chat card, the sponsor credit line and the ledger's username.
// Money is still credited — privacy changes who is named, not what was paid.

'use strict';
process.env.KOFI_VERIFICATION_TOKEN = 'kofi-test-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerPaymentWebhooks } = require('./webhooks.js');

// ── Ko-fi ───────────────────────────────────────────────────────────────────

function kofiRig() {
  const dispatched = [];
  const routes = {};
  registerPaymentWebhooks({
    app: { post: (p, h) => { routes[p] = h; } },
    wrap: (fn) => fn,
    alert: { dispatch: async (x) => { dispatched.push(x); } },
  });
  const post = async (data) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } };
    const quiet = console.log;
    console.log = () => {};
    try { await routes['/webhook/kofi']({ body: { data: JSON.stringify({ verification_token: 'kofi-test-token', ...data }) } }, res); }
    finally { console.log = quiet; }
    return res;
  };
  return { dispatched, post };
}

test('Ko-fi is_public:false names nobody and reads nothing out — and still credits the money', async () => {
  const { dispatched, post } = kofiRig();
  await post({ kofi_transaction_id: 'tx-1', from_name: 'Casey Private', message: 'my secret note',
    amount: '25.00', currency: 'USD', type: 'Donation', is_public: false });
  assert.equal(dispatched.length, 1);
  const d = dispatched[0];
  assert.equal(d.username, 'Anonymous', 'a private Ko-fi supporter was named on stream');
  assert.equal(d.message, '', 'a private Ko-fi message was read out / shown');
  assert.equal(d.amount, 25, 'privacy must not drop the money');
  assert.equal(d.currency, 'USD');
});

test('Ko-fi is_public:false on a membership is private too', async () => {
  const { dispatched, post } = kofiRig();
  await post({ kofi_transaction_id: 'tx-2', from_name: 'Casey Private', message: 'note',
    amount: '5.00', currency: 'USD', type: 'Subscription', is_subscription_payment: true, is_public: false });
  assert.equal(dispatched[0].username, 'Anonymous');
  assert.equal(dispatched[0].message, '');
  assert.equal(dispatched[0].amount, 5);
});

test('Ko-fi public (or unspecified) keeps the name and message', async () => {
  const { dispatched, post } = kofiRig();
  await post({ kofi_transaction_id: 'tx-3', from_name: 'casey', message: 'hello', amount: '3', currency: 'USD', type: 'Donation', is_public: true });
  await post({ kofi_transaction_id: 'tx-4', from_name: 'casey', message: 'hello', amount: '3', currency: 'USD', type: 'Donation' });
  assert.deepEqual(dispatched.map((d) => [d.username, d.message]), [['casey', 'hello'], ['casey', 'hello']]);
});
