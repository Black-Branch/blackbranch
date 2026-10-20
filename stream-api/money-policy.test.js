// MONEY-POLICY GUARD for /chat/event (money.js) — the accounting model:
//
//   • Buying Qorm is ONLY a wallet top-up (site.coin_ledger, written
//     web-side). It must NEVER touch the bar, the timer, or support_events,
//     and never fires a public event.
//   • SPENDING Qorm — cheer, sticker, sticker_boost, tts_msg, sound — is
//     spectacle: it must move NOTHING. The night is funded by money GIVEN to
//     it, not by points earned and spent back at it (a spend that lit the
//     clock could be earned faster, then spent to earn faster again).
//   • Real-money kinds (donation, gift, sub) credit Stripe NET, not gross and
//     never a coin amount.
//   • Never credit both ends: a purchase that also wrote support_events would
//     double-count the same money.
//
// Getting this wrong does not throw. It silently invents or destroys real
// money. money.js exports the policy as DATA (KIND_POLICY — every take-home amount is derived from it through
// takeHome()) and the route as a driveable handler, so the same invariants are
// asserted against real behavior: fake deps in, observed money calls out. The
// card shapes come from the REAL alert.buildEventCard, so the request bodies
// here are the real wire shapes.
//
// A new kind added to COIN_KINDS without a KIND_POLICY decision refuses to
// BOOT (module-load throw); the exhaustiveness tests pin the sets against
// each other so drift in either direction fails here too.
//
// Run: node --test money-policy.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  createMoney, KIND_POLICY, COIN_KINDS, MONEY_KINDS, makePersistEventCard,
} = require('./money');
const { buildEventCard } = require('./alert');   // the REAL card builder

// ── the policy table IS the accounting model ─────────────────────────────────

test('every accepted kind has an explicit accounting decision — and nothing else does', () => {
  const accepted = new Set([...COIN_KINDS, ...MONEY_KINDS]);
  assert.deepEqual(new Set(Object.keys(KIND_POLICY)), accepted,
    'KIND_POLICY and the accepted kinds have drifted apart — the boot check should have thrown');
  for (const k of accepted) {
    assert.ok(['face', 'stripe_net', 'none'].includes(KIND_POLICY[k].credit),
      `kind '${k}' has no valid credit decision`);
  }
});

test('the decisions themselves: NONE for Qorm spends, net for real money, none for sinks', () => {
  for (const k of ['cheer', 'sticker', 'sticker_boost'])
    assert.equal(KIND_POLICY[k].credit, 'none', `${k} is spectacle, not support — it must move NOTHING`);
  for (const k of ['donation', 'gift', 'sub'])
    assert.equal(KIND_POLICY[k].credit, 'stripe_net', `${k} must credit the Stripe NET — never gross, never coins`);
  for (const k of ['tts_msg', 'sound'])
    assert.equal(KIND_POLICY[k].credit, 'none', `${k} is a sink — it must move NOTHING`);
});

test('credit:none ⇔ COIN_KINDS — the exclusion list handed to every support_events fold is exactly the non-funding kinds', () => {
  for (const k of Object.keys(KIND_POLICY)) {
    assert.equal(KIND_POLICY[k].credit === 'none', COIN_KINDS.has(k),
      `${k}: a kind that credits nothing must be a COIN_KIND (so the folds exclude it), and a funding kind must not be`);
  }
});

// ── drive the real handler ───────────────────────────────────────────────────

const NET = 0.83; // marker multiplier so a face amount can never equal a net amount

function harness({ poolQuery, ttsEnabled = true, supportBar, broadcast, fireStreamEffects } = {}) {
  const calls = [];
  const log = (fn, x) => { calls.push({ fn, ...x }); };
  const money = createMoney({
    pool: { query: poolQuery || (async () => ({ rows: [{}], rowCount: 1 })) },
    economics: {
      stripeNet: (usd) => { log('stripeNet', { usd }); return usd * NET; },
      formatUSD: (u) => `$${u.toFixed(2)}`,
    },
    alert: {
      buildEventCard,
      fireStreamEffects: fireStreamEffects || (async (args) => { log('fireStreamEffects', { args }); return { addedSeconds: 42 }; }),
      dispatch: async () => {},
    },
    supportBar: supportBar || { add: (usd, who) => { log('supportBar.add', { usd, who }); return { deltaSeconds: 7 }; }, reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return { usdPerHour: 0, fillUsd: 0 }; } },
    tts: { speak: (t) => log('tts.speak', { t }) },
    sounds: { play: async (id) => { log('sounds.play', { id }); return true; }, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async () => { log('persist', {}); return 999; },
    maskBlacklist: (t) => t,
    broadcast: broadcast || ((f) => log('broadcast', { type: f.type, frame: f })),
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

test('donation credits the Stripe NET of the charge — derived through the policy', async () => {
  const h = harness();
  const res = await h.post({ kind: 'donation', donor: 'Don', amount: 1000, message: 'hi' });
  assert.equal(res.body.ok, true);
  const fx = h.calls.find((c) => c.fn === 'fireStreamEffects');
  assert.ok(fx, 'donation no longer fires the alert fan-out');
  assert.equal(fx.args.takeHomeUSD, 10 * NET, 'take-home must be stripeNet($10), not gross and not face');
  assert.ok(h.calls.some((c) => c.fn === 'stripeNet' && c.usd === 10), 'the net was not derived via economics.stripeNet');
});

test('gift and sub credit the Stripe NET too', async () => {
  const g = harness();
  await g.post({ kind: 'gift', gifter: 'G', recipients: [{ name: 'R' }], months: 1, amount: 499 });
  assert.equal(g.calls.find((c) => c.fn === 'fireStreamEffects').args.takeHomeUSD, 4.99 * NET);

  const s = harness();
  await s.post({ kind: 'sub', subscriber: 'S', tier: '1', months: 2, amount: 500 });
  assert.equal(s.calls.find((c) => c.fn === 'fireStreamEffects').args.takeHomeUSD, 5 * NET);
});

// ── Qorm is channel points: a spend is spectacle, never support ──

test('a sticker broadcasts its overlay frame and credits NOTHING', async () => {
  const h = harness();
  const res = await h.post({ kind: 'sticker', username: 'S', emoteUrl: 'https://cdn/e.webp', emoteName: 'e', coins: 200, senderMatrixId: '@s:site.test' });
  assert.deepEqual(h.credits(), [], 'a sticker moved money');
  assert.ok(h.calls.some((c) => c.fn === 'broadcast' && c.type === 'showSticker'), 'the overlay frame is the product');
  assert.equal(res.body.ok, true);
  assert.ok(h.calls.some((c) => c.fn === 'persist'), 'the chat line still posts');
});

test('a sticker effect that THROWS is refused so the web route refunds — the gate keys on refundFlag, not credit', async () => {
  // With stickers at credit:'none', the old gate (`credit !== 'none'` → 500)
  // would have swallowed the throw, persisted the card and kept the coins.
  const h = harness({ broadcast: () => { throw new Error('ws hub down'); } });
  const res = await h.post({ kind: 'sticker', username: 'S', senderMatrixId: '@s:site.test', emoteUrl: 'https://cdn/e.webp', emoteName: 'e', coins: 300 });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'effects_failed');
  assert.ok(!h.calls.some((c) => c.fn === 'persist'), 'no card for an effect that never happened');
});

test('sinks move NOTHING: tts_msg / sound / highlight never touch bar, ledger, or alert', async () => {
  const bodies = {
    tts_msg:   { username: 'T', message: 'say this', coins: 100 },
    sound:     { username: 'S', soundId: 'airhorn', coins: 50 },
    // highlight: a fixed-price chat highlight — same 'credit: none' policy as
    // tts_msg/sound, but with its own effect handler rather than a refundFlag.
    // `announce` is read by nothing, so a policy-field assertion cannot catch a
    // highlight that starts moving the bar or firing the alert fan-out. This
    // drives a REAL 'highlight' request through the route and checks the
    // actual effect.
    highlight: { username: 'H', cheererMatrixId: '@h:site.test', usernameColor: '#0af', coins: 50, message: 'look at this' },
  };
  for (const [kind, body] of Object.entries(bodies)) {
    const h = harness();
    const res = await h.post({ kind, ...body });
    assert.deepEqual(h.credits(), [],
      `${kind} moved money — a sink kind must never credit the bar, the ledger, or the alert path`);
    assert.equal(res.statusCode, 200);
  }
});

test('paid TTS that cannot run is refused so the web route refunds — no card, no credit', async () => {
  const h = harness({ ttsEnabled: false });
  const res = await h.post({ kind: 'tts_msg', username: 'T', message: 'say this', coins: 100 });
  assert.deepEqual(res.body, { ok: false, spoken: false });
  assert.ok(!h.calls.some((c) => c.fn === 'persist'), 'a card was posted for an effect that never ran');
});

test('sticker_boost VERIFIES the target before any credit — a 404 moves no money', async () => {
  const h = harness({
    poolQuery: async (sql) => {
      if (String(sql).includes('SELECT 1 FROM site.chat_messages')) return { rows: [], rowCount: 0 };
      return { rows: [{}], rowCount: 1 };
    },
  });
  const res = await h.post({
    kind: 'sticker_boost', username: 'S', emoteUrl: 'https://cdn/e.webp', emoteName: 'e',
    coins: 400, boostCoins: 400, originalMessageId: 77,
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(h.credits(), [],
    'a boost aimed at a non-sticker id credited money — verify-before-credit regression');
});

test('a valid sticker_boost moves the existing card and credits NOTHING', async () => {
  const h = harness({
    poolQuery: async (sql) => {
      if (String(sql).includes('SELECT 1 FROM site.chat_messages')) return { rows: [{}], rowCount: 1 };
      if (String(sql).includes('UPDATE site.chat_messages')) return { rows: [{ id: 55, event_json: {} }], rowCount: 1 };
      return { rows: [{}], rowCount: 1 };
    },
  });
  const res = await h.post({
    kind: 'sticker_boost', username: 'S', emoteUrl: 'https://cdn/e.webp', emoteName: 'e',
    coins: 400, boostCoins: 400, originalMessageId: 77,
  });
  assert.equal(res.body.id, 55, 'the boost must ride the EXISTING sticker row, never a new one');
  assert.deepEqual(h.credits(), [], 'a boost moved money');
  assert.ok(h.calls.some((c) => c.fn === 'broadcast' && c.type === 'stickerMove'));
});

test('an unknown kind is rejected outright', async () => {
  const h = harness();
  const res = await h.post({ kind: 'jackpot', username: 'X', coins: 10 });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(h.credits(), []);
});

// ── Effect-throw handling for sticker_boost's card UPDATE ───────────────────
// A handler that THREW never reached its effect (the refund gate in money.js
// keys on this) — the route must answer with an error (the web spend routes
// refund on non-ok) instead of moving the card for an effect that never
// happened, or the web keeps the viewer's coins for a boost whose overlay pop
// never fired. (The sticker/cheer throw cases are pinned with their own kind's
// tests above.)

test('sticker_boost with failed effects never reaches the card UPDATE (coins were kept before)', async () => {
  let updated = false;
  const h = harness({
    broadcast: () => { throw new Error('ws hub down'); },
    poolQuery: async (sql) => {
      if (/UPDATE site\.chat_messages/.test(sql)) { updated = true; return { rows: [{ id: 55, event_json: {} }], rowCount: 1 }; }
      return { rows: [{}], rowCount: 1 };
    },
  });
  const res = await h.post({
    kind: 'sticker_boost', username: 'S', emoteUrl: 'https://cdn/e.webp', emoteName: 'e',
    coins: 400, boostCoins: 400, originalMessageId: 77,
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'effects_failed');
  assert.equal(updated, false, 'the boost UPDATE ran anyway — ok:true would keep the coins');
});

test('index.js hands COIN_KINDS to every support_events fold as excludeEventTypes', () => {
  const src = readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /const SPEND_EVENT_TYPES = \[\.\.\.COIN_KINDS\]/, 'vacuity anchor: the list is derived from COIN_KINDS, not hand-written');
  // The key is pinned on the FIRST line of each call, by literal — slicing a
  // call to its closing `);` is unreliable here (supportBar's onAdd arrow
  // contains `);` of its own before the end of the call).
  assert.match(src, /createAggregates\(\{\s*pool, excludeEventTypes: SPEND_EVENT_TYPES,/, 'createAggregates folds support_events without the exclusion');
  assert.match(src, /createSponsors\(\{\s*pool, broadcast, timer, excludeEventTypes: SPEND_EVENT_TYPES,/, 'createSponsors folds support_events without the exclusion');
  assert.match(src, /createSupportBar\(\{\s*pool, broadcast, excludeEventTypes: SPEND_EVENT_TYPES,/, 'createSupportBar folds support_events without the exclusion');
});

test('highlight is a coin kind with an explicit no-credit policy', () => {
  const { COIN_KINDS, KIND_POLICY } = require('./money.js');
  assert.ok(COIN_KINDS.has('highlight'), 'highlight must be a COIN_KIND');
  assert.equal(KIND_POLICY.highlight.credit, 'none');
});

// THE RE-ADMISSION GUARD. index.js derives SPEND_EVENT_TYPES from
// COIN_KINDS and injects it as excludeEventTypes into supportbar/sponsors/
// aggregates. Those predicates exclude HISTORICAL support_events rows written
// when Qorm spends still credited — face-value cheers. Nothing can buy a cheer,
// which is exactly why someone will eventually try to delete this entry as
// dead. It is not dead; it is load-bearing for five folds.
test('cheer stays in COIN_KINDS even though nothing can buy one', () => {
  const { COIN_KINDS, KIND_POLICY } = require('./money.js');
  assert.ok(COIN_KINDS.has('cheer'), 'removing cheer re-admits historical face-value rows into five folds');
  assert.equal(KIND_POLICY.cheer.credit, 'none');
});

test('no coin kind fires the alert fan-out any more', () => {
  const { COIN_KINDS, KIND_POLICY } = require('./money.js');
  for (const k of COIN_KINDS) {
    assert.notEqual(KIND_POLICY[k].announce, 'alert', `${k} must not announce as an alert`);
    assert.notEqual(KIND_POLICY[k].announce, 'threshold', `${k}: the threshold tier is retired`);
  }
  // Positive control — without this the loop above passes over an empty set.
  assert.equal(KIND_POLICY.donation.announce, 'alert');
});

// ── persisted card actor: the DB row must carry the same identity the live
// card does ──────────────────────────────────────────────────────────────────
//
// makePersistEventCard picks the matrix_id it writes to site.chat_messages off
// a FIELD NAME keyed by `kind` — a second, independent read of the same card
// alert.buildEventCard already built. alert.test.js covers the card shapes; a
// kind missing from the actor ternary falls through to null without failing
// those. These drive the REAL buildEventCard into the REAL persistEventCard,
// the two-hop path, against a fake pool
// that records what matrix_id the INSERT actually received.

function fakeChatMessagesPool() {
  const inserted = [];
  const pool = {
    query: async (sql, params) => {
      if (/INSERT INTO site\.chat_messages/.test(sql)) {
        inserted.push(params[0]); // matrix_id is $1
        return { rows: [{ id: inserted.length }] };
      }
      return { rows: [{}] };
    },
  };
  return { pool, inserted };
}

test('a highlight card persists with the spender\'s matrix id, not null', async () => {
  const { pool, inserted } = fakeChatMessagesPool();
  const persistEventCard = makePersistEventCard(pool);
  const base = { type: 'message', platform: 'system', id: 'h1', system: 'highlight', ts: Date.now() };
  const card = buildEventCard('highlight',
    { username: 'Hal', cheererMatrixId: '@hal:site.test', usernameColor: '#0af', coins: 50, message: 'read this' },
    base);
  const id = await persistEventCard(card);
  assert.equal(id, 1, 'persist should have succeeded on the first insert attempt');
  assert.equal(inserted[0], '@hal:site.test',
    'a highlight card persisted with matrix_id NULL — the actor ternary is missing the highlight arm');
});

test('a tts_msg card built from what chat/send now sends persists with the spender\'s matrix id, not null', async () => {
  const { pool, inserted } = fakeChatMessagesPool();
  const persistEventCard = makePersistEventCard(pool);
  const base = { type: 'message', platform: 'system', id: 't1', system: 'tts_msg', ts: Date.now() };
  // senderMatrixId, NOT cheererMatrixId — this is the field
  // web/app/api/chat/send/route.ts sends for mode:"tts", and the field
  // alert.js's tts_msg branch actually destructures. Sending cheererMatrixId
  // here (the highlight field) would silently reproduce the regression this
  // test exists to catch.
  const card = buildEventCard('tts_msg',
    { username: 'Hal', senderMatrixId: '@hal:site.test', usernameColor: '#0af', coins: 150, message: 'read this' },
    base);
  const id = await persistEventCard(card);
  assert.equal(id, 1, 'persist should have succeeded on the first insert attempt');
  assert.equal(inserted[0], '@hal:site.test',
    'a tts_msg card persisted with matrix_id NULL');
});

// Positive control for the two tests above: without a genuinely-null case, a
// stub actor ternary that just always forwarded SOME field on the card (or a
// pool fake that echoed back whatever param it was called with) could pass
// both assertions above without actually depending on `kind`.
test('positive control: a card with no identity field at all persists as matrix_id NULL', async () => {
  const { pool, inserted } = fakeChatMessagesPool();
  const persistEventCard = makePersistEventCard(pool);
  const base = { type: 'message', platform: 'system', id: 'h2', system: 'highlight', ts: Date.now() };
  const card = buildEventCard('highlight',
    { username: 'Anon', coins: 50, message: 'no identity field at all' },
    base);
  const id = await persistEventCard(card);
  assert.equal(id, 1, 'persist should have succeeded on the first insert attempt');
  assert.equal(inserted[0], null,
    'a card with no cheererMatrixId should persist as matrix_id NULL, not invent an actor');
});
