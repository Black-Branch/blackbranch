// A real-money amount is cents IN A CURRENCY; the donation/gift/sub handlers
// must not treat it as USD cents unconditionally.
//
// The checkout routes only mint USD sessions, so this is a backstop —
// but web's recordCoinPurchase already guards this EXACT case for currency purchases
// (Stripe adaptive pricing can settle a session in the buyer's local
// currency), because crediting a foreign-cents number as USD moves real value
// by a number in the wrong unit, in an unknown direction. The contract,
// recordCoinPurchase's shape:
//   • non-USD → credit NOTHING automatically + notify(critical) — a human
//     reconciles from site.donations, which stores the true currency;
//   • the chat card still posts (the celebration is not the ledger);
//   • absent currency = legacy caller → USD, matching the dedup's NULL
//     fail-open (never break the paths that predate the field).
//
// Refusing-to-credit is NOT capping take-home: a capped credit silently
// keeps the wrong number; this refuses to invent one and pages instead.
//
// Run: node --test money-currency.test.js

'use strict';

process.env.NTFY_WAKE_URL = 'https://ntfy.example/wake';
process.env.NTFY_QUIET_URL = 'https://ntfy.example/quiet';
process.env.OPS_NOTIFY_COOLDOWN_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney } = require('./money.js');
const { buildEventCard } = require('./alert.js');
const { _resetNotifyState } = require('./notify.js');

const realFetch = global.fetch;

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
  await new Promise((r) => setTimeout(r, 10));
  return sent;
}

function harness() {
  const calls = [];
  const log = (fn, x) => { calls.push({ fn, ...x }); };
  const money = createMoney({
    pool: { query: async () => ({ rows: [{}], rowCount: 1 }) },
    economics: { stripeNet: (usd) => usd * 0.83, formatUSD: (u) => `$${u.toFixed(2)}` },
    alert: {
      buildEventCard,
      fireStreamEffects: async (args) => { log('fireStreamEffects', { args }); return { addedSeconds: 42 }; },
      dispatch: async () => {},
    },
    supportBar: { add: (usd, who, id) => { log('supportBar.add', { usd, who, id }); return { deltaSeconds: 7 }; }, reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return { usdPerHour: 0, fillUsd: 0 }; } },
    tts: { speak: () => {} },
    sounds: { play: async () => true, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async () => 999,
    maskBlacklist: (t) => t,
    broadcast: (f) => log('broadcast', { type: f.type, kind: f.kind }),
    bufferPush: () => {}, bufferReplace: () => {},
    ttsEnabled: () => false,
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

const DONATION = {
  kind: 'donation', donor: 'D', anonymous: false, amount: 500, message: 'hi',
  spendId: 'cs_x1',
};

test('a USD donation credits exactly as before', async () => {
  const h = harness();
  const res = await h.post({ ...DONATION, currency: 'usd' });
  assert.equal(res.statusCode, 200);
  assert.ok(h.calls.some((c) => c.fn === 'fireStreamEffects'), 'the USD path must be untouched');
});

test('a donation with NO currency field stays fail-open (legacy caller = USD)', async () => {
  const h = harness();
  await h.post({ ...DONATION });
  assert.ok(h.calls.some((c) => c.fn === 'fireStreamEffects'),
    'a legacy payload without currency was refused — that breaks every pre-field caller');
});

test('a non-USD donation credits NOTHING and pages — but the card still posts', async () => {
  const h = harness();
  let res;
  const sent = await captureNotifications(async () => {
    res = await h.post({ ...DONATION, spendId: 'cs_eur', currency: 'eur' });
  });
  assert.equal(res.statusCode, 200, 'the event itself is not an error — the money movement is what is refused');
  assert.ok(!h.calls.some((c) => c.fn === 'fireStreamEffects'),
    '500 EUR-cents was credited as USD cents — value moved in the wrong unit');
  assert.ok(h.calls.some((c) => c.fn === 'broadcast' && c.type === 'message'),
    'the celebration card must still post — the viewer really did donate');
  assert.ok(sent.some((n) => /non-usd/i.test(JSON.stringify(n))),
    'nothing paged — a silent skip is the impressions-outage shape');
});

test('non-USD sub and gift announces are refused the same way', async () => {
  for (const body of [
    { kind: 'sub', subscriber: 'S', tier: 'Supporter', months: 1, amount: 500, currency: 'eur', spendId: 'sub_x' },
    { kind: 'gift', gifter: 'G', recipients: [{ name: 'R' }], count: 1, months: 1, amount: 500, currency: 'cad', spendId: 'gift_x' },
  ]) {
    const h = harness();
    await captureNotifications(async () => { await h.post(body); });
    assert.ok(!h.calls.some((c) => c.fn === 'fireStreamEffects'),
      `${body.kind}: a non-USD amount reached the USD credit path`);
  }
});


// ── native support events carry the payer's matrix id to the alert ─
//
// Without `userId` on the donation/gift/sub alert dispatches, every native
// donation resolves by NAME ALONE — and since identity requires proof, that
// means a brand-new canonical per event. The card's own key per kind
// (buildEventCard) is what must reach fireStreamEffects.
function userIdSentBy(h) {
  const c = h.calls.find((x) => x.fn === 'fireStreamEffects');
  return c ? c.args.userId : '(no fireStreamEffects call)';
}

test('a native donation hands the DONOR\'s matrix id to the alert as userId', async () => {
  const h = harness();
  await h.post({ ...DONATION, currency: 'usd', donorMatrixId: '@d:site.test' });
  assert.equal(userIdSentBy(h), '@d:site.test');
});

test('a native sub hands the SUBSCRIBER\'s matrix id, a gift the GIFTER\'s', async () => {
  const s = harness();
  await s.post({ kind: 'sub', subscriber: 'S', subscriberMatrixId: '@s:site.test', tier: 'Supporter', months: 1, amount: 500, currency: 'usd', spendId: 'sub_id1' });
  assert.equal(userIdSentBy(s), '@s:site.test');
  const g = harness();
  await g.post({ kind: 'gift', gifter: 'G', gifterMatrixId: '@g:site.test', recipients: [{ name: 'R' }], count: 1, months: 1, amount: 500, currency: 'usd', spendId: 'gift_id1' });
  assert.equal(userIdSentBy(g), '@g:site.test', 'the gifter pays — never the recipient');
});

test('an ANONYMOUS native donation sends no userId (and stays its own row downstream)', async () => {
  const h = harness();
  await h.post({ ...DONATION, currency: 'usd', anonymous: true, donor: 'Anonymous', donorMatrixId: null });
  assert.equal(userIdSentBy(h), undefined);
});

// The currency is channel points: a coin spend is spectacle,
// never support, so it must never reach the ledger or the bar — the canonical
// id resolved by recordSupport is irrelevant here because recordSupport is
// never called at all. (Donations/subs/gifts still credit through
// alert.fireStreamEffects — alert.test.js pins that leg.)
test('a native coin spend (sticker) never reaches recordSupport or supportBar.add — the currency is channel points', async () => {
  const STICKER = { kind: 'sticker', username: 'S', emoteUrl: 'https://cdn/e.webp', emoteName: 'e', coins: 200, senderMatrixId: '@gadgetfan:site.test' };
  const h = harness();
  const res = await h.post(STICKER);
  assert.equal(res.body.ok, true);
  assert.ok(!h.calls.some((c) => c.fn === 'supportBar.add'),
    'a sticker credited the night');
});

// ── a PayPal capture's own reported net (money.js:takeHome) ─────────────────
//
// economics.stripeNet(usd) is right for a native Stripe charge, wrong for a
// PayPal tip, whose fee is not Stripe's. PayPal's capture reports its own true
// net (seller_receivable_breakdown.net_amount.value, arriving here as
// body.netUsd), so it is an AUTHORITY, not a second calculation: a finite
// net in (0, gross] is credited exactly; anything else is nonsensical and
// falls back to stripeNet(gross), loudly.
//
// Never cap take-home: the upper guard here refuses a net ABOVE what was
// actually paid (impossible, not "large") — it must not clamp a legitimate
// big tip down to gross.
//
// The harness's economics.stripeNet stub is `usd => usd * 0.83`, distinct
// from any of the netUsd values below, so "fell back to stripeNet" and
// "credited the reported net" are never accidentally the same number.
function grossOf(h) {
  return h.calls.find((c) => c.fn === 'fireStreamEffects').args.grossUSD;
}
function takeHomeSentBy(h) {
  return h.calls.find((c) => c.fn === 'fireStreamEffects').args.takeHomeUSD;
}

test('a donation with a valid netUsd credits exactly that — not stripeNet(gross)', async () => {
  const h = harness();
  await h.post({ ...DONATION, currency: 'usd', spendId: 'pp_valid', netUsd: 4.55 }); // gross $5.00
  assert.equal(grossOf(h), 5);
  assert.equal(takeHomeSentBy(h), 4.55);
});

test('a PayPal subscription sale with a valid netUsd credits exactly that — the sub kind carries the reported net like a tip', async () => {
  const h = harness();
  await h.post({ kind: 'sub', subscriber: 'S', subscriberMatrixId: '@s:site.test', tier: 'Supporter', months: 1, amount: 500, currency: 'usd', spendId: 'paypal-sub:I-1', netUsd: 4.34 }); // gross $5.00
  // the sub effect carries no grossUSD (the tier's price is the gross), so only the take-home is asserted
  assert.equal(takeHomeSentBy(h), 4.34, 'the sale\'s own net, never stripeNet(gross) = 4.15');
});

test('a card subscription without a netUsd still credits stripeNet(gross) — the Stripe path is unchanged', async () => {
  const h = harness();
  await h.post({ kind: 'sub', subscriber: 'S', subscriberMatrixId: '@s:site.test', tier: 'Supporter', months: 1, amount: 500, currency: 'usd', spendId: 'sub_card' });
  assert.equal(takeHomeSentBy(h), 5 * 0.83, 'the harness stub stripeNet(5), unrounded by the fallback');
});

test('a netUsd greater than the gross is nonsense, not a big tip — refused, falls back to stripeNet(gross)', async () => {
  const h = harness();
  await h.post({ ...DONATION, currency: 'usd', spendId: 'pp_over', netUsd: 6.00 }); // gross $5.00
  assert.equal(takeHomeSentBy(h), 5 * 0.83);
});

test('a netUsd of a LEGITIMATE large tip is credited in full — the guard never clamps a real amount', async () => {
  const h = harness();
  // amount is in cents (centsUsd divides by 100): $500.00 gross, PayPal reports $488.20 net.
  await h.post({ ...DONATION, amount: 50000, currency: 'usd', spendId: 'pp_whale', netUsd: 488.20 });
  assert.equal(grossOf(h), 500);
  assert.equal(takeHomeSentBy(h), 488.20, 'a large legitimate net must survive intact, uncapped');
});

for (const [label, bad] of [
  ['zero', 0],
  ['negative', -1.5],
  ['NaN', NaN],
  ['a non-numeric string', 'not-a-number'],
  ['null', null],
]) {
  test(`a netUsd of ${label} is refused and falls back to stripeNet(gross)`, async () => {
    const h = harness();
    await h.post({ ...DONATION, currency: 'usd', spendId: `pp_bad_${label.replace(/\s+/g, '_')}`, netUsd: bad });
    assert.equal(takeHomeSentBy(h), 5 * 0.83);
  });
}

test('no netUsd at all credits stripeNet(gross) exactly as today — the regression guard', async () => {
  const h = harness();
  await h.post({ ...DONATION, currency: 'usd', spendId: 'pp_none' });
  assert.equal(takeHomeSentBy(h), 5 * 0.83);
});
