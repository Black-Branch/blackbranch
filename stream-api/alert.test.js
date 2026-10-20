// Tests for alert.js (fan-out) + supportbar.js (math). No network/DB.
// Run: node --test alert.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlert, cleanForTTS, buildShowAlert, buildEventCard } = require('./alert');
const { NATIVE_PLATFORM } = require('./native-platform');
const { createSupportBar } = require('./supportbar');
const { scanSource, at } = require('./testlib/source');

test('cleanForTTS strips URLs and :emote: tokens', () => {
  assert.equal(cleanForTTS('check https://x.com out :PogU: now'), 'check out now');
  assert.equal(cleanForTTS('hello world'), 'hello world');
  assert.equal(cleanForTTS(''), '');
  assert.equal(cleanForTTS(':kek: :lul:'), ''); // all emotes → empty
});

// R2-16: donor text reaches ElevenLabs as-is, so markup in a message could
// reach the engine — a `<break time="10s"/>` or an SSML tag the donor chose.
// cleanForTTS strips any <…> tag, including one with spaces inside it.
test('cleanForTTS strips <…> markup, even a tag with spaces inside it', () => {
  assert.equal(cleanForTTS('hi <break time="10s"/> there'), 'hi there');
  assert.equal(cleanForTTS('<speak><prosody rate="x-fast">fast</prosody></speak>'), 'fast');
  assert.equal(cleanForTTS('a<b>bold</b>word'), 'a bold word');
  // Nesting must not reassemble a tag out of what one pass leaves behind.
  for (const nested of ['hi <break time="10s"<b>/> there', 'hi <<b>break/> there']) {
    const out = cleanForTTS(nested);
    assert.doesNotMatch(out, /[<>]/, `markup survived: ${JSON.stringify(nested)} → ${JSON.stringify(out)}`);
  }
  // Narration never needs an angle bracket: a lone one becomes a space.
  assert.equal(cleanForTTS('3 < 5 and 7 > 2'), '3 5 and 7 2');
});

test('buildShowAlert shape', () => {
  const a = buildShowAlert({ platform: 'twitch', eventType: 'sub', username: 'x', amount: '$2.50', months: 3 });
  assert.equal(a.type, 'showAlert');
  assert.equal(a.platform, 'twitch');
  assert.equal(a.amount, '$2.50');
  assert.equal(a.months, '3');         // stringified
  assert.equal(a.recipient, '');       // defaults
});

test('dispatch fans out + computes take-home from economics', async () => {
  const broadcasts = [], spoken = [], supported = [], logged = [];
  const alert = createAlert({
    broadcast: (m) => broadcasts.push(m),
    bufferPush: () => {},
    obs: { playSound: async () => {} },
    tts: { speak: (t) => spoken.push(t) },
    supportBar: { add: (v, u) => supported.push({ v, u }) },
    logSupport: async (row) => logged.push(row),
  });

  await alert.dispatch({
    platform: 'twitch', eventType: 'giftbomb', username: 'gifter',
    tier: 'tier 1', count: 5, label: 'gifted 5 subs',
    message: 'enjoy https://t.co/x :PogU:',
  });

  const types = broadcasts.map((b) => b.type);
  assert.ok(types.includes('showAlert'), 'showAlert broadcast');
  // There is no money-bearing `alert` frame — a reappearance would be an
  // unregistered frame (wsFrameContract).
  assert.ok(!types.includes('alert'), 'the removed alert frame came back');
  assert.ok(broadcasts.some((b) => b.type === 'message' && b.system === 'alert'), 'system card');

  const show = broadcasts.find((b) => b.type === 'showAlert');
  assert.equal(show.amount, '$12.48');             // 4.99×5×0.5 = 12.475 → 12.48

  assert.deepEqual(spoken, ['enjoy']);             // url + emote stripped
  assert.deepEqual(supported, [{ v: 12.48, u: 'gifter' }]);
  assert.equal(logged[0].amountUsd, 12.48);
  assert.equal(logged[0].platform, 'twitch');
});

test('dispatch honors explicit takeHomeUSD (native Stripe path)', async () => {
  const supported = [];
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    obs: { playSound: async () => {} }, tts: { speak: () => {} },
    supportBar: { add: (v, u) => supported.push({ v, u }) },
    logSupport: async () => {},
  });
  await alert.fireStreamEffects({ platform: NATIVE_PLATFORM, eventType: 'donation', username: 'd', takeHomeUSD: 9.41, message: '' });
  assert.deepEqual(supported, [{ v: 9.41, u: 'd' }]);
});

test('buildEventCard: donation card shape + blacklist mask', () => {
  const base = { type: 'message', platform: 'system', id: 'd1', system: 'donation', ts: 1 };
  const card = buildEventCard('donation',
    { donor: 'Dee', donorMatrixId: '@dee:site.test', amount: 500, currency: 'USD', message: 'hi BADWORD', usernameColor: '#fff' },
    base, (s) => s.replace('BADWORD', '***'));
  assert.equal(card.system, 'donation');
  assert.equal(card.username, 'Dee');
  assert.equal(card.amount, 500);          // cents
  assert.equal(card.currency, 'usd');      // lowercased
  assert.equal(card.message, 'hi ***');    // masked
});

test('buildEventCard: sub card shape', () => {
  const base = { type: 'message', platform: 'system', id: 's1', system: 'sub', ts: 1 };
  const card = buildEventCard('sub',
    { subscriber: 'Sue', subscriberMatrixId: '@sue:site.test', usernameColor: '#abc', tier: 'Supporter', months: 1, amount: 499, currency: 'usd' },
    base);
  assert.equal(card.system, 'sub');
  assert.equal(card.username, 'Sue');
  assert.equal(card.tier, 'Supporter');
  assert.equal(card.amount, 499);
  assert.equal(card.subscriberMatrixId, '@sue:site.test');
});

test('buildEventCard: cheer card shape + blacklist mask + zero-coin null', () => {
  const base = { type: 'message', platform: 'system', id: 'c1', system: 'cheer', ts: 1 };
  const card = buildEventCard('cheer',
    { username: 'Che', cheererMatrixId: '@che:site.test', usernameColor: '#fd0', coins: 500, message: 'gg BADWORD' },
    base, (s) => s.replace('BADWORD', '***'));
  assert.equal(card.system, 'cheer');
  assert.equal(card.username, 'Che');
  assert.equal(card.coins, 500);            // 1 coin = 1¢; NO takeHome on the card
  assert.equal(card.cheererMatrixId, '@che:site.test');
  assert.equal(card.message, 'gg ***');     // masked
  // A zero/invalid coin count builds nothing (the route then skips).
  assert.equal(buildEventCard('cheer', { username: 'x', coins: 0 }, base), null);
});

test('buildEventCard: highlight card shape — sender identity + masked message, not the donation fall-through', () => {
  // Plan-defect regression: `highlight` was added to money.js's
  // COIN_KINDS/KIND_POLICY without a buildEventCard arm, so a real highlight
  // send fell through every `if (kind === ...)` check to the bare donation
  // branch at the bottom — reading body.donor/body.amount/body.currency (none
  // of which a highlight payload carries) under a `system: 'highlight'` tag.
  // The card IS the product for a highlight (money.js's effect handler is a
  // pure no-op — see money-policy.test.js), so this is load-bearing, not
  // cosmetic.
  const base = { type: 'message', platform: 'system', id: 'h1', system: 'highlight', ts: 1 };
  const card = buildEventCard('highlight',
    { username: 'Hal', cheererMatrixId: '@hal:site.test', usernameColor: '#0af', coins: 50, message: 'read this BADWORD' },
    base, (s) => s.replace('BADWORD', '***'));
  assert.ok(card, 'a highlight must build a card, not fall through to the donation shape');
  assert.equal(card.system, 'highlight');        // base.system — the donation branch never sets one
  assert.equal(card.username, 'Hal');
  assert.equal(card.matrixId, '@hal:site.test');  // NOT card.donorMatrixId — proves this isn't the donation shape
  assert.equal(card.coins, 50);                   // NOT card.amount — a highlight has no dollar amount
  assert.equal(card.message, 'read this ***');    // masked
  // Positive control — without a call that legitimately returns null here,
  // `assert.ok(card)` above passes over a hole (e.g. it would still pass if
  // buildEventCard NEVER returned null for anything, which is exactly the
  // failure mode a silent fall-through produces). `highlight` shares its
  // whole branch — including the `coins <= 0 → null` guard — with `cheer`,
  // whose own test above pins the same case; assert it here too, on
  // `highlight` specifically, since that's the kind this test is about.
  assert.equal(buildEventCard('highlight', { username: 'x', coins: 0 }, base), null);
});

test('buildEventCard: gift with no recipients → null', () => {
  const base = { type: 'message', platform: 'system', id: 'g1', system: 'gift', ts: 1 };
  assert.equal(buildEventCard('gift', { gifter: 'G', recipients: [] }, base), null);
});

test('createAlert instance exposes buildEventCard (the /chat/event route uses alert.buildEventCard)', () => {
  const alert = createAlert({ broadcast: () => {}, bufferPush: () => {}, obs: null, tts: null, supportBar: null, logSupport: async () => {} });
  assert.equal(typeof alert.buildEventCard, 'function');
  const base = { type: 'message', platform: 'system', id: 's1', system: 'sub', ts: 1 };
  assert.equal(alert.buildEventCard('sub', { subscriber: 'Sue', amount: 499 }, base).system, 'sub');
});

test('fireStreamEffects: native sub credits support bar + speaks (TTS enabled)', async () => {
  const broadcasts = [], spoken = [], supported = [], logged = [];
  const alert = createAlert({
    broadcast: (m) => broadcasts.push(m),
    bufferPush: () => {},
    obs: { playSound: async () => {} },
    tts: { speak: (t) => spoken.push(t) },        // simulates ALERT_TTS_ENABLED=1
    supportBar: { add: (v, u) => supported.push({ v, u }) },
    logSupport: async (row) => logged.push(row),
  });
  await alert.fireStreamEffects({
    platform: NATIVE_PLATFORM, eventType: 'sub', username: 'Sue', label: 'subscribed',
    tier: 'Supporter', months: 1, message: 'thanks for having me!', takeHomeUSD: 4.55,
  });
  assert.equal(broadcasts.find((b) => b.type === 'showAlert').eventType, 'sub');
  assert.deepEqual(supported, [{ v: 4.55, u: 'Sue' }]);
  assert.equal(logged[0].eventType, 'sub');
  assert.deepEqual(spoken, ['thanks for having me!']);
});

test('fireStreamEffects: gift subs now credit take-home (no longer $0)', async () => {
  const supported = [];
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    obs: { playSound: async () => {} }, tts: null,
    supportBar: { add: (v, u) => supported.push({ v, u }) },
    logSupport: async () => {},
  });
  await alert.fireStreamEffects({ platform: NATIVE_PLATFORM, eventType: 'gift', username: 'G', label: 'gifted 1 sub', takeHomeUSD: 4.55 });
  assert.deepEqual(supported, [{ v: 4.55, u: 'G' }]);
});

test('supportbar add + $ total + earnTime delegation', () => {
  const sent = [];
  // earnTime is injected by index.js (→ timer.addMoney); here it converts $ to
  // seconds at $40/hr so we can assert the delegated deltaSeconds.
  const earnTime = (usd) => Math.round((usd / 40) * 3600);
  const bar = createSupportBar({ pool: null, broadcast: (m) => sent.push(m), getStreamId: async () => null, earnTime });

  const r1 = bar.add(40, 'a');
  assert.equal(bar.getTotal(), 40);
  assert.equal(r1.total, 40);
  assert.equal(r1.deltaSeconds, 3600);              // $40 → 1h, from earnTime
  assert.equal(sent[0].type, 'updateSupportBar');
  assert.equal(sent[0].total, 40);
  assert.equal(sent[0].delta, 40);

  bar.add(0, 'b');                                  // no-op, no broadcast
  assert.equal(sent.length, 1);

  bar.reset();
  assert.equal(bar.getTotal(), 0);
  assert.equal(sent[1].type, 'resetSupportBar');
});

test('supportbar onAdd fires after a successful bump, not on the no-op path, and a throw does not break add()', () => {
  let called = 0;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 0,
    onAdd: () => { called += 1; },
  });

  const r1 = bar.add(10, 'x');
  assert.equal(called, 1);
  assert.equal(r1.total, 10);              // add()'s return value is unaffected

  bar.add(0, 'x');                          // no-op path: onAdd must not fire
  assert.equal(called, 1);

  const throwing = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 0,
    onAdd: () => { throw new Error('boom'); },
  });
  const r2 = throwing.add(5, 'y');          // onAdd throwing must not break add()
  assert.equal(r2.total, 5);
});

// onAdd's payload shape, and its ordering relative to the broadcast + earnTime
// it depends on.
test('supportbar onAdd payload: username, cents, grossSec, notionalSec — after the bar bump AND earnTime', () => {
  const order = [];
  const payloads = [];
  const bar = createSupportBar({
    pool: null,
    broadcast: (m) => order.push(`broadcast:${m.type}`),
    getStreamId: async () => null,
    earnTime: (usd) => { order.push('earnTime'); return Math.round((usd / 40) * 3600); },
    notionalFor: (usd) => Math.round((usd / 24) * 3600), // a different (uncapped) rate than earnTime
    onAdd: (payload) => { order.push('onAdd'); payloads.push(payload); },
  });

  bar.add(24, 'Gifter');

  assert.deepEqual(order, ['broadcast:updateSupportBar', 'earnTime', 'onAdd']);
  assert.deepEqual(payloads, [{
    username: 'Gifter',
    userId: null,       // no canonical id handed in — the pool keys on the username
    cents: 2400,
    grossSec: 2160,     // $24 / $40/hr * 3600 = 2160s, from earnTime
    notionalSec: 3600,  // $24 / $24/hr * 3600 = 3600s, from notionalFor — deliberately different
    ledgerId: null,     // no ledger row id handed in (the sponsor pool's rebuild journal dedupes on it)
  }]);
});

test('supportbar onAdd payload: a missing username still ships an empty string, never undefined', () => {
  let payload;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 5, onAdd: (p) => { payload = p; },
  });
  bar.add(1); // no username arg
  assert.equal(payload.username, '');
});

test('supportbar onAdd payload: notionalFor throwing falls back to grossSec (a corrupt night frontier)', () => {
  let payload;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 42,
    notionalFor: () => { throw new Error('frontierSec below first sellable block'); },
    onAdd: (p) => { payload = p; },
  });
  const r = bar.add(10, 'z');
  assert.equal(payload.notionalSec, 42);   // fell back to grossSec, not lost
  assert.equal(payload.grossSec, 42);
  assert.equal(r.total, 10);               // the contribution itself is unaffected
  assert.equal(r.deltaSeconds, 42);
});

test('supportbar onAdd payload: no notionalFor injected -> notionalSec defaults to grossSec', () => {
  let payload;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 17, onAdd: (p) => { payload = p; },
  });
  bar.add(3, 'a');
  assert.equal(payload.notionalSec, 17);
  assert.equal(payload.grossSec, 17);
});

// Review round 2, minor 5d: a notionalFor that returns something unusable
// WITHOUT throwing (NaN, undefined, Infinity) must be coerced back to
// grossSec just like the throwing case — it must never ride onto the payload
// as-is.
test('supportbar onAdd payload: notionalFor returning a non-finite value (no throw) still falls back to grossSec', () => {
  for (const badValue of [NaN, undefined, Infinity, -Infinity]) {
    let payload;
    const bar = createSupportBar({
      pool: null, broadcast: () => {}, getStreamId: async () => null,
      earnTime: () => 9,
      notionalFor: () => badValue,
      onAdd: (p) => { payload = p; },
    });
    bar.add(1, 'q');
    assert.equal(payload.notionalSec, 9, `notionalFor() -> ${badValue} should fall back to grossSec`);
  }
});

test('supportbar onAdd payload: a HIGHER finite notionalFor quote wins over grossSec', () => {
  let payload;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 9,
    notionalFor: () => 40, // an uncapped/unclamped quote worth more than what the timer actually granted
    onAdd: (p) => { payload = p; },
  });
  bar.add(1, 'q');
  assert.equal(payload.notionalSec, 40);
});

// notionalSec FLOORS at grossSec — a finite quote that is LOWER than what was
// actually granted must not win (see the docblock at the floor's call site in
// supportbar.js).
test('supportbar onAdd payload: a LOWER finite notionalFor quote is floored at grossSec, not used as-is', () => {
  let payload;
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 9,
    notionalFor: () => 0, // e.g. a post-move quote that under-priced against a later, pricier block
    onAdd: (p) => { payload = p; },
  });
  bar.add(1, 'q');
  assert.equal(payload.notionalSec, 9, 'the floor must win: 9 actually granted, never reported as less');
});

// notionalFor is called AFTER earnTime has already mutated the REAL frontier for this same
// donation. For an ordinary in-range donation on a RAMPING curve, earnTime's
// own credit can consume an entire cheap block and land the frontier exactly
// at a pricier one — a post-move quote for the SAME dollars then prices
// entirely against that pricier territory and comes back LOWER than what was
// actually granted. Built on a REAL createTimer + createSupportBar wired
// exactly like index.js (earnTime -> timer.addMoney, notionalFor ->
// timer.convertNotional) — not a mock standing in for the interaction.
test('supportbar onAdd payload: an in-range donation on a RAMPING curve reports grossSec, not the smaller post-move quote', () => {
  const { createTimer } = require('./timer');
  const timer = createTimer({ broadcast: () => {}, obs: null, pool: null });

  // A 2h night, two 1h blocks, priced well above the flat floor so the two
  // blocks have MEANINGFULLY different per-second rates (block 1 cheaper,
  // block 2 pricier — makeWeights ramps 0.8 -> 1.7 across the night).
  timer.startNight({ endLocal: '+2h', seedSec: 0, priceCents: 100_000, now: Date.now() });
  const blocks = timer.__test.st.night.blocks;
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].cents < blocks[1].cents, 'sanity: the curve must actually ramp for this test to mean anything');

  // Size the donation to buy EXACTLY all of block 1 — grossSec should land
  // exactly on the block1/block2 boundary, so a post-move query prices
  // ENTIRELY against block 2's pricier rate.
  const donationUsd = blocks[0].cents / 100;

  const sent = [];
  const bar = createSupportBar({
    pool: null, broadcast: (m) => sent.push(m), getStreamId: async () => null,
    earnTime: (usd) => timer.addMoney(usd),
    notionalFor: (usd) => timer.convertNotional(usd),
    onAdd: (p) => { sent.push({ payload: p }); },
  });

  const r = bar.add(donationUsd, 'Whale');
  assert.equal(r.deltaSeconds, blocks[0].lenSec, 'sanity: the donation bought exactly all of block 1');

  const payloadEntry = sent.find((s) => s.payload).payload;
  // The bug this closes: a naive post-move quote would price the SAME
  // dollars entirely against block 2 (pricier) and come back well under
  // blocks[0].lenSec. The floor must report the TRUE granted value instead.
  const naivePostMoveQuote = timer.convertNotional(donationUsd); // what the bug would have reported
  assert.ok(naivePostMoveQuote < blocks[0].lenSec,
    'sanity: the post-move quote must actually be smaller, or this test proves nothing');
  assert.equal(payloadEntry.grossSec, blocks[0].lenSec);
  assert.equal(payloadEntry.notionalSec, blocks[0].lenSec, 'floored at grossSec — NOT the smaller post-move quote');
});

// An external payment platform (Ko-fi / Patreon / Streamlabs / superchats)
// delivers donor text to the TTS voice, the OBS alert and the persisted chat card,
// so a slur in a donation message or display name must be masked before any of
// them. Masking lives in fireStreamEffects so every dispatch() caller
// is covered, including integrations that do not exist yet.
test('external alerts mask the blacklist in BOTH message and username', async () => {
  const broadcasts = [], spoken = [];
  const mask = (s) => String(s || '').replace(/badword/gi, '****');
  const alert = createAlert({
    broadcast: (m) => broadcasts.push(m),
    bufferPush: () => {},
    obs: { playSound: async () => {} },
    tts: { speak: (t) => spoken.push(t) },
    supportBar: { add: () => ({ deltaSeconds: 0 }) },
    logSupport: async () => {},
    maskBlacklist: mask,
  });

  await alert.dispatch({
    platform: 'kofi', eventType: 'donation', username: 'badword_guy',
    amount: 5, currency: 'USD', message: 'here is a badword for you', label: 'donated on ko-fi',
  });

  const all = JSON.stringify(broadcasts) + JSON.stringify(spoken);
  assert.ok(!/badword/i.test(all), 'no unmasked term may reach ANY broadcast or the TTS queue');
  assert.ok(/\*\*\*\*/.test(all), 'the masked form should be present');
  assert.ok(spoken.length > 0, 'TTS should still speak the masked text');
});

// A missing maskBlacklist dep must not crash the alert path — it degrades to
// identity so an alert still fires (fail-open here is correct: the alternative is
// dropping a paid donation's celebration entirely).
test('createAlert tolerates a missing maskBlacklist', async () => {
  const broadcasts = [];
  const alert = createAlert({
    broadcast: (m) => broadcasts.push(m),
    bufferPush: () => {},
    obs: { playSound: async () => {} },
    tts: null,
    supportBar: { add: () => ({ deltaSeconds: 0 }) },
    logSupport: async () => {},
  });
  await alert.dispatch({
    platform: 'kofi', eventType: 'donation', username: 'x', amount: 1, currency: 'USD', message: 'hi',
  });
  assert.ok(broadcasts.length > 0, 'alert still fires without a mask fn');
});

test('buildSystemCard marks a locked marathon, not just zero seconds', () => {
  const { buildSystemCard } = require('./alert');
  const ended = buildSystemCard({ username: 'x', amount: 5, addedSeconds: 0, marathonEnded: true });
  assert.equal(ended.marathonEnded, true);
  // A tiny donation that rounds to no seconds is NOT the marathon ending.
  const tiny = buildSystemCard({ username: 'x', amount: 5, addedSeconds: 0 });
  assert.equal(tiny.marathonEnded, false);
});

// Donation cards from external platforms show their dollar amount: dispatch
// computes the display string and buildSystemCard carries it, for DONATIONS
// ONLY: a resub/giftsub card must never leak the internal per-sub revenue
// estimate that `amount` holds for those events.
test('buildSystemCard carries the display amount for donations only', () => {
  const { buildSystemCard } = require('./alert');
  const don = buildSystemCard({ username: 'x', eventType: 'donation', amount: '$285.00', addedSeconds: 60 });
  assert.equal(don.amountText, '$285.00');
  const resub = buildSystemCard({ username: 'x', eventType: 'resub', amount: '$2.50', addedSeconds: 0 });
  assert.equal(resub.amountText, '', 'non-donation events never expose the economics amount');
  const bare = buildSystemCard({ username: 'x', eventType: 'donation', addedSeconds: 0 });
  assert.equal(bare.amountText, '', 'missing amount stays an empty string, never undefined');
});

// ── A gold night is `locked` too, and is not an ending ────────────────────
//
// timer.js's `isLocked()` is atCeiling() OR atFloor() — and during an active
// night, atCeiling() IS `night.funded` (frontier reached durationSec). So a
// gold-night donation that lands at/past the ceiling has addedSeconds===0
// AND timer.snapshot().locked===true, the exact pair fireStreamEffects reads
// as "the marathon ended". Without the night.active guard, a
// donation on a gold night would broadcast a "marathon ended" card for the
// stream's best moment.
//
// index.js wires `timerLocked` as `() => { const s = timer.snapshot(); return
// s.locked && !s.night.active; }` — mirrored here exactly (not re-imported;
// index.js is the composition root and starts real listeners, so it is not
// require()-able for a unit test — same reasoning as notify-wiring.test.js's
// own inline harnesses). A source-text drift between this and the real
// injection would only be caught by eyeballing both, so keep them identical
// on any future edit to either.
function timerLockedFrom(nightActive) {
  return () => {
    const s = { locked: true, night: { active: nightActive } };
    return s.locked && !s.night.active;
  };
}

test('marathonEnded is false for a zero-applied donation on a GOLD night', async () => {
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    supportBar: { add: () => ({ deltaSeconds: 0 }) }, // at the night's ceiling — nothing left to buy
    obs: null, tts: null,
    logSupport: async () => ({ duplicate: false }),
    timerLocked: timerLockedFrom(true), // night.active
  });
  const { addedSeconds, marathonEnded } = await alert.fireStreamEffects({
    platform: 'kofi', eventType: 'donation', username: 'x', amount: 20, currency: 'USD',
  });
  assert.equal(addedSeconds, 0, 'premise: the donation must add zero seconds for this to test anything');
  assert.equal(marathonEnded, false, 'a gold night read as a marathon ending');
});

test('takeHomeUSD 0 (a Qorm spend): no ledger, no bar, card still fires — and marathonEnded stays false even under a lock', async () => {
  // A big cheer rides fireStreamEffects for its overlay/sound/TTS moment with
  // NOTHING to credit, so "added 0 seconds while locked" alone must not read as
  // marathonEnded — every such cheer would satisfy it.
  const supported = [], logged = [], broadcasts = [];
  const alert = createAlert({
    broadcast: (m) => broadcasts.push(m), bufferPush: () => {}, obs: null, tts: null,
    supportBar: { add: (v, u, id) => { supported.push({ v, u, id }); return { deltaSeconds: 0 }; } },
    logSupport: async (row) => { logged.push(row); return { duplicate: false }; },
    timerLocked: () => true,
  });
  const out = await alert.fireStreamEffects({
    platform: NATIVE_PLATFORM, eventType: 'cheer', username: 'C', label: 'cheered 500', takeHomeUSD: 0,
  });
  assert.deepEqual(logged, [], 'a zero take-home wrote a ledger row');
  assert.deepEqual(supported, [], 'a zero take-home credited the bar');
  assert.equal(out.takeHome, 0);
  assert.equal(out.addedSeconds, 0);
  assert.equal(out.marathonEnded, false, 'a spend read as "the marathon ended"');
  assert.ok(broadcasts.some((b) => b.type === 'showAlert'), 'the overlay moment is the whole point');
});

test('marathonEnded is still true for a legacy floor/ceiling lock (no night active)', async () => {
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    supportBar: { add: () => ({ deltaSeconds: 0 }) },
    obs: null, tts: null,
    logSupport: async () => ({ duplicate: false }),
    timerLocked: timerLockedFrom(false), // no night — the pre-Task-8 marathon path
  });
  const { addedSeconds, marathonEnded } = await alert.fireStreamEffects({
    platform: 'kofi', eventType: 'donation', username: 'x', amount: 20, currency: 'USD',
  });
  assert.equal(addedSeconds, 0, 'premise: the donation must add zero seconds for this to test anything');
  assert.equal(marathonEnded, true, 'a legacy locked marathon must still read as ended');
});

// ── the injection itself ───────────────────────────────────────────────────
//
// The two tests above pin the FIXED LOGIC by hand-copying it into a local
// `timerLockedFrom` closure — necessary because index.js is a composition
// root (opens a DB pool, an HTTP server, a WS server, an OBS socket at
// require time) and is not require()-able for a unit test, same reasoning
// shutdown.test.js and webhooks.test.js already give for scanning its
// source text instead. But a hand copy can drift from the real injection
// silently — nothing fails if someone edits index.js and forgets this file. This test closes that gap from the other side: it reads the ACTUAL
// injected `timerLocked` value out of index.js and asserts its SHAPE (not a
// byte-exact match, which would be brittle to a harmless reformat) — that it
// reads `.locked` and negates `night.active`.
test('index.js wiring: the timerLocked injection actually guards on locked AND !night.active', () => {
  // Same tail anchor shutdown.test.js/webhooks.test.js already use for
  // index.js — scanSource asserts it near the end of the file, so a
  // truncated read (and every assertion below going vacuously green over a
  // deleted injection) fails loudly instead of passing quietly.
  const src = scanSource('index.js', /unhandledRejection/);
  const timerLockedAt = at(src, 'timerLocked:');
  // A bounded window right after the property, not "anywhere in the file" —
  // the file legitimately says `.locked` and `night.active` elsewhere (e.g.
  // inside timer.js's own snapshot(), which index.js does not define but
  // could plausibly be confused with by an unbounded scan). 200 chars comfortably
  // covers the whole injected arrow function body without reaching the next
  // property in the createAlert(...) call.
  const injection = src.slice(timerLockedAt, timerLockedAt + 200);
  assert.match(injection, /\.locked\b/,
    'the timerLocked injection no longer reads .locked at all — marathonEnded would be permanently false');
  assert.match(injection, /!\s*[\w$.]*night\.active/,
    'the timerLocked injection no longer negates night.active — a gold night would read as a marathon ending again (the exact bug this fix closed)');
});

// The name on the wire is the name chat shows: the ledger's
// canonical id must reach the sponsor pool from the LIVE path too.
test('dispatch hands the canonical id the ledger resolved to supportBar.add — and null when the ledger did not say', async () => {
  const supported = [];
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {}, obs: null, tts: null,
    supportBar: { add: (v, u, id) => { supported.push({ v, u, id }); return { deltaSeconds: 0 }; } },
    logSupport: async () => ({ canonicalId: 'a60500127435', duplicate: false }),
  });
  await alert.dispatch({ platform: 'streamlabs', eventType: 'donation', username: 'GadgetFan', amount: 4.56, takeHomeUSD: 4.56 });
  assert.deepEqual(supported, [{ v: 4.56, u: 'GadgetFan', id: 'a60500127435' }]);

  const bare = [];
  const alert2 = createAlert({
    broadcast: () => {}, bufferPush: () => {}, obs: null, tts: null,
    supportBar: { add: (v, u, id) => { bare.push({ v, u, id }); return { deltaSeconds: 0 }; } },
    logSupport: async () => {},
  });
  await alert2.dispatch({ platform: 'streamlabs', eventType: 'donation', username: 'GadgetFan', amount: 4.56, takeHomeUSD: 4.56 });
  assert.deepEqual(bare, [{ v: 4.56, u: 'GadgetFan', id: null }]);
});

// ── donation spoken-length tiers (tts-tiers.js) ─────────────────────────────
// Local factory, not a file-wide export: every existing test above builds its
// own createAlert() inline (there is no shared builder to reuse), so this one
// factory just saves repeating the same broadcast/obs/tts/supportBar/logSupport
// shape across the handful of cases below.
function harness() {
  const spoken = [];
  const alert = createAlert({
    broadcast: () => {},
    bufferPush: () => {},
    obs: { playSound: async () => {} },
    tts: { speak: (t) => spoken.push(t) },
    supportBar: { add: () => ({ deltaSeconds: 0 }) },
    logSupport: async () => {},
  });
  return { alert, spoken };
}

test('spoken donation text is cut at the tier for the gross amount', async () => {
  const { alert, spoken } = harness();
  const long = 'w'.repeat(600);
  await alert.fireStreamEffects({ platform: NATIVE_PLATFORM, eventType: 'donation', username: 'a', amount: '$3.00', message: long, grossUSD: 3, takeHomeUSD: 2.5 });
  await alert.fireStreamEffects({ platform: NATIVE_PLATFORM, eventType: 'donation', username: 'b', amount: '$10.00', message: long, grossUSD: 10, takeHomeUSD: 9 });
  await alert.fireStreamEffects({ platform: NATIVE_PLATFORM, eventType: 'donation', username: 'c', amount: '$30.00', message: long, grossUSD: 30, takeHomeUSD: 28 });
  assert.equal(spoken[0].length, 50);
  assert.equal(spoken[1].length, 300);
  assert.equal(spoken[2].length, 500);
});

test('a non-donation with a long message still speaks up to the card cap', async () => {
  const { alert, spoken } = harness();
  await alert.fireStreamEffects({ platform: 'twitch', eventType: 'sub', username: 'd', message: 'x'.repeat(700), takeHomeUSD: 2.5 });
  assert.equal(spoken[0].length, 500);
});

test('a donation dispatched with no grossUSD speaks the smallest tier (never the old unbounded read)', async () => {
  const { alert, spoken } = harness();
  await alert.dispatch({ platform: 'kofi', eventType: 'donation', username: 'e', amount: 20, currency: 'USD', message: 'y'.repeat(400) });
  assert.equal(spoken[0].length, 50);
});

test('grossUSD survives dispatch() through to the spoken tier (nothing strips it on the way through)', async () => {
  const { alert, spoken } = harness();
  await alert.dispatch({ platform: 'kofi', eventType: 'donation', username: 'f', amount: 30, currency: 'USD', message: 'z'.repeat(600), grossUSD: 30 });
  assert.equal(spoken[0].length, 500);
});
