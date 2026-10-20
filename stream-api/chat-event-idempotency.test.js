// POST /chat/event idempotency — the receiving half of the web's retry-not-
// refund contract.
//
// The web's deadline aborts its WAIT, not this handler's WORK. On a slow DB,
// stream-api would proceed to credit while the web route saw its abort and
// refunded — "never credit both ends" broken by a stall, for every concurrent
// spend, for the stall's duration. So the web retries instead of refunding.
//
// The contract (full idempotency-key semantics, keyed kind:spendId — the
// spendId is the web's coin-ledger ref, minted once per spend):
//   • a COMPLETED spend re-delivered → the ORIGINAL response body, verbatim,
//     plus deduped:true — verbatim matters for the refundFlag kinds, whose
//     `spoken`/`played` drive web-side refunds;
//   • a REFUSED spend (400/404/effects_failed) is NOT recorded — the refusal
//     reached nothing, so a retry must re-process and a refund stays legal;
//   • a spend still IN FLIGHT (or that died mid-work) → 409 in_flight —
//     neither re-run (could double-credit) nor replayed (outcome unknown);
//   • no spendId → fail-open (the billing webhook's gift/donation/sub cards
//     carry their own replay guard upstream).
//
// Run: node --test chat-event-idempotency.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney } = require('./money.js');
const { buildEventCard } = require('./alert.js');

// ── harness (money-policy.test.js's, unchanged) ─────────────────────────────

function harness({ poolQuery, ttsEnabled = true, sounds, fireStreamEffects } = {}) {
  const calls = [];
  const log = (fn, x) => { calls.push({ fn, ...x }); };
  const money = createMoney({
    pool: { query: poolQuery || (async () => ({ rows: [{}], rowCount: 1 })) },
    economics: {
      stripeNet: (usd) => { log('stripeNet', { usd }); return usd * 0.83; },
      formatUSD: (u) => `$${u.toFixed(2)}`,
    },
    alert: {
      buildEventCard,
      fireStreamEffects: fireStreamEffects || (async (args) => { log('fireStreamEffects', { args }); return { addedSeconds: 42 }; }),
      dispatch: async () => {},
    },
    supportBar: { add: (usd, who) => { log('supportBar.add', { usd, who }); return { deltaSeconds: 7 }; }, reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return { usdPerHour: 0, fillUsd: 0 }; } },
    tts: { speak: (t) => log('tts.speak', { t }) },
    sounds: sounds || { play: async (id) => { log('sounds.play', { id }); return true; }, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async () => { log('persist', {}); return 999; },
    maskBlacklist: (t) => t,
    broadcast: (f) => log('broadcast', { type: f.type }),
    bufferPush: () => {}, bufferReplace: () => {},
    ALERT_TTS_ENABLED: ttsEnabled,
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
  const credits = () => calls.filter((c) => ['recordSupport', 'supportBar.add', 'fireStreamEffects'].includes(c.fn));
  return { calls, post, credits };
}

// Qorm spends (cheer/highlight/sticker/...) credit NOTHING and await nothing
// (cheer is a pure `{ addedSeconds: 0 }` sink). A MONEY_KIND credits and is
// awaitable via fireStreamEffects, so donation is the vehicle for these
// idempotency tests.
const DONATION = { kind: 'donation', donor: 'D', donorMatrixId: '@u:l.io', amount: 1000, message: 'hi' };

test('a re-delivered spendId replays the original outcome and credits ONCE', async () => {
  const h = harness();
  const first = await h.post({ ...DONATION, spendId: 'spend-abc-1' });
  const creditsAfterFirst = h.credits().length;
  assert.ok(creditsAfterFirst > 0, 'the first delivery must credit');
  const second = await h.post({ ...DONATION, spendId: 'spend-abc-1' });
  assert.equal(h.credits().length, creditsAfterFirst,
    'the retry credited AGAIN — the exact double-credit this contract exists to prevent');
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.ok, first.body.ok, 'the replay must carry the original outcome');
  assert.equal(second.body.id, first.body.id, 'the replay must carry the original card id');
});

test('a refund-flag outcome is replayed VERBATIM — `played` drives a web refund', async () => {
  let plays = 0;
  const h = harness({ sounds: { play: async () => { plays += 1; return false; }, manifest: () => ({}) } });
  const first = await h.post({ kind: 'sound', username: 'U', soundId: 's1', coins: 100, spendId: 'spend-snd-1' });
  assert.equal(first.body.played, false, 'precondition: the effect could not run');
  const second = await h.post({ kind: 'sound', username: 'U', soundId: 's1', coins: 100, spendId: 'spend-snd-1' });
  assert.equal(plays, 1, 'the retry re-played the sound');
  assert.equal(second.body.played, false,
    'the replay lost the refundFlag — the web would keep coins for a sound that never played');
  assert.equal(second.body.deduped, true);
});

test('a REFUSED spend is not recorded — a retry re-processes it', async () => {
  let prechecks = 0;
  const h = harness({
    poolQuery: async (sql) => {
      if (/SELECT 1 FROM site\.chat_messages/.test(sql)) { prechecks += 1; return { rows: [], rowCount: 0 }; }
      return { rows: [{}], rowCount: 1 };
    },
  });
  const body = { kind: 'sticker_boost', username: 'U', coins: 0, boostCoins: 200,
    emoteName: 'pog', emoteUrl: 'https://cdn.example/pog.png',
    originalMessageId: '123', spendId: 'spend-boost-1' };
  const first = await h.post(body);
  assert.equal(first.statusCode, 404, 'precondition: the boost target does not exist');
  const second = await h.post(body);
  assert.equal(second.statusCode, 404,
    'the retry was answered from the outcome store — a refusal must stay retryable');
  assert.equal(prechecks, 2, 'the retry must re-run the precheck, not be deduped');
});

test('no spendId → fail-open, both deliveries process', async () => {
  const h = harness();
  await h.post({ ...DONATION });
  const creditsAfterFirst = h.credits().length;
  await h.post({ ...DONATION });
  assert.equal(h.credits().length, creditsAfterFirst * 2,
    'two id-less events were deduped by content — the billing webhook\'s cards would break');
});

test('a spend still in flight answers 409 — never a second credit, never a fake outcome', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({
    fireStreamEffects: async () => { await gate; return { addedSeconds: 42 }; },
  });
  // fireStreamEffects is the awaited effect the gate blocks — every coin kind
  // (cheer/highlight/sticker/...) is a synchronous no-op sink and awaits
  // nothing injectable, so a MONEY_KIND is the only vehicle
  // that can be held open mid-request.
  const inFlight = h.post({ ...DONATION, spendId: 'spend-race-1' });   // deliberately not awaited
  await new Promise((r) => setImmediate(r));                        // let it reach the credit await
  const second = await h.post({ ...DONATION, spendId: 'spend-race-1' });
  assert.equal(second.statusCode, 409,
    'a concurrent duplicate must be refused as in_flight — re-running it can double-credit');
  assert.equal(second.body.error, 'in_flight');
  release();
  const first = await inFlight;
  assert.equal(first.body.ok, true, 'the original delivery must still complete');
});
