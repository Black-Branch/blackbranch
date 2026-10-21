// webhooks.js: which donor name is public, and that none reaches the journal.
// Run: node --test webhooks-donor-names.test.js
//
// Patreon: the member's `full_name` is the name on their account — often a
// legal name — so it is never shown on stream, spoken, carded or written to
// the ledger. Only a name the patron chose for public display (the included
// user's `vanity`) may be shown; otherwise "A patron".
//
// Logs: the Ko-fi, Patreon and Streamlabs log lines print no donor name to
// journald, which is kept and read far from the people who gave. They log
// the transaction / member / donation id and the amount only — on success and
// on failure.

'use strict';
process.env.KOFI_VERIFICATION_TOKEN = 'kofi-test-token';
process.env.PATREON_WEBHOOK_SECRET = 'patreon-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { registerPaymentWebhooks, createStreamlabsHandler } = require('./webhooks.js');

const SECRET_NAME = 'Casey Q. Legalname';

function captureLogs() {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  return { lines, restore: () => Object.assign(console, saved) };
}

function routes(dispatch) {
  const r = {};
  registerPaymentWebhooks({ app: { post: (p, h) => { r[p] = h; } }, wrap: (fn) => fn, alert: { dispatch } });
  return r;
}
const fakeRes = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; } });

function patreonReq(body) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = crypto.createHmac('md5', 'patreon-test-secret').update(raw).digest('hex');
  const headers = { 'X-Patreon-Signature': sig, 'X-Patreon-Event': 'members:pledge:create' };
  return { body, rawBody: raw, get: (h) => headers[h] };
}

const pledge = (included = []) => ({
  data: { id: 'member-1', type: 'member', attributes: { full_name: SECRET_NAME, will_pay_amount_cents: 500, currency: 'USD' } },
  included,
});

test('Patreon never shows full_name; a public vanity name is used when the payload has one', async () => {
  const got = [];
  const r = routes(async (x) => { got.push(x); });
  const cap = captureLogs();
  try {
    await r['/webhook/patreon'](patreonReq(pledge()), fakeRes());
    await r['/webhook/patreon'](patreonReq(pledge([{ type: 'user', id: 'u1', attributes: { full_name: SECRET_NAME, vanity: 'gadgetfan' } }])), fakeRes());
  } finally { cap.restore(); }
  assert.deepEqual(got.map((d) => d.username), ['A patron', 'gadgetfan'],
    'a patron\'s account name (often a legal name) was used as their public name');
  assert.equal(got[0].cents, 500, 'the money must still be credited');
});

test('no donor name reaches a log line — Ko-fi, Patreon, Streamlabs, success and failure', async () => {
  const cap = captureLogs();
  try {
    const ok = routes(async () => {});
    const boom = routes(async () => { throw new Error('dispatch broke'); });
    const kofi = (tx) => ({ body: { data: JSON.stringify({ verification_token: 'kofi-test-token', kofi_transaction_id: tx,
      from_name: SECRET_NAME, amount: '5', currency: 'USD', type: 'Donation' }) } });
    await ok['/webhook/kofi'](kofi('tx-a'), fakeRes());
    await boom['/webhook/kofi'](kofi('tx-b'), fakeRes());
    await ok['/webhook/patreon'](patreonReq(pledge()), fakeRes());
    await boom['/webhook/patreon'](patreonReq({ ...pledge(), x: 1 }), fakeRes());
    const sl = createStreamlabsHandler({ alert: { dispatch: async () => {} } });
    sl({ type: 'donation', message: [{ _id: 'sl-1', name: SECRET_NAME, amount: '5', currency: 'USD' }] });
    await new Promise((r) => setImmediate(r));
  } finally { cap.restore(); }
  // Vacuity anchor: the handlers did log — the assertion below is about WHAT.
  assert.ok(cap.lines.some((l) => l.includes('tx-a')) && cap.lines.some((l) => /FAILED/.test(l)) &&
    cap.lines.some((l) => l.includes('sl-1')) && cap.lines.some((l) => l.includes('member-1')),
    `expected success and failure lines naming the ids, got: ${JSON.stringify(cap.lines)}`);
  for (const l of cap.lines) assert.ok(!l.includes('Legalname'), `a donor name reached the journal: ${l}`);
});
