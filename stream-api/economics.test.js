// Unit tests for economics.js — asserts the take-home catalog.
// Run: node --test economics.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./economics');

test('tierAmount', () => {
  assert.equal(E.tierAmount('tier 1'), 4.99);
  assert.equal(E.tierAmount('tier 2'), 9.99);
  assert.equal(E.tierAmount('TIER 3'), 24.99);
  assert.equal(E.tierAmount('prime'), 4.99);
  assert.equal(E.tierAmount(''), 4.99);       // default → tier 1
  assert.equal(E.tierAmount(undefined), 4.99);
});

test('toUSD', () => {
  assert.equal(E.toUSD(10, 'USD'), 10);
  assert.equal(E.toUSD(8, 'EUR'), 8.64);      // 8 × 1.08
  assert.equal(E.toUSD(100, 'JPY'), 0.66);    // 100 × 0.0066
});

// An unknown currency must NOT pass through as USD. The old behaviour treated
// an unrecognised code as 1:1, which over-credits the support bar by the inverse
// of the real rate — ₫100,000 (~$4) would have credited $100,000. Crediting 0 and
// logging loudly is the safe direction; the alert still fires, it just does not
// move the money totals until the currency is added to CURRENCY_RATES.
test('toUSD: unknown currency credits 0, never passthrough', () => {
  assert.equal(E.toUSD(5, 'XYZ'), 0);
  assert.equal(E.toUSD(100000, 'XYZ'), 0);
});

// Regression net: less common currencies a missing rate would pass through as USD.
// Each must resolve to a real rate rather than being mistaken for USD.
test('toUSD: the less common currencies resolve, not passthrough', () => {
  for (const code of ['VND', 'IDR', 'COP', 'HUF', 'CZK', 'PHP', 'ZAR', 'CNY', 'TWD', 'ILS']) {
    const oneUnit = E.toUSD(1, code);
    assert.notEqual(oneUnit, 1, `${code} must not pass through as 1:1 USD`);
    assert.ok(oneUnit >= 0, `${code} must not be negative`);
  }
  // Spot-check the direction on a low-value currency: 100k VND is single-digit USD.
  const vnd = E.toUSD(100000, 'VND');
  assert.ok(vnd > 0 && vnd < 50, `100000 VND should be a few dollars, got ${vnd}`);
});

test('formatUSD', () => {
  assert.equal(E.formatUSD(2.5), '$2.50');
  assert.equal(E.formatUSD(0), '$0.00');
  assert.equal(E.formatUSD(12.48), '$12.48'); // always fed an already-rounded value
  assert.equal(E.formatUSD(E.round2(24.99)), '$24.99');
});

test('twitch sub take-home', () => {
  assert.equal(E.twitchSubTakeHome({ tier: 'tier 1', months: 1 }), 2.50);
  assert.equal(E.twitchSubTakeHome({ tier: 'tier 2', months: 1 }), 5.00);
  assert.equal(E.twitchSubTakeHome({ tier: 'tier 3', months: 1 }), 12.50);
  assert.equal(E.twitchSubTakeHome({ tier: 'tier 1', months: 3 }), 7.49);
  assert.equal(E.twitchSubTakeHome({ tier: 'prime', months: 1 }), 2.50);
  assert.equal(E.twitchSubTakeHome({}), 2.50); // defaults tier1 ×1
});

test('twitch flat (resub / upgrades / pay-it-forward)', () => {
  assert.equal(E.twitchFlatTakeHome({ tier: 'tier 1' }), 2.50);
  assert.equal(E.twitchFlatTakeHome({ tier: 'tier 2' }), 5.00);
  assert.equal(E.twitchFlatTakeHome({ tier: 'tier 3' }), 12.50);
});

test('twitch gift bomb', () => {
  assert.equal(E.twitchGiftbombTakeHome({ tier: 'tier 1', count: 5 }), 12.48); // 4.99×5×0.5=12.475
  assert.equal(E.twitchGiftbombTakeHome({ tier: 'tier 1', count: 1 }), 2.50);
  assert.equal(E.twitchGiftbombTakeHome({ tier: 'tier 3', count: 2 }), 24.99); // 24.99×2×0.5
});

test('twitch bits', () => {
  assert.equal(E.twitchBitsTakeHome({ bits: 100 }), 1.00);
  assert.equal(E.twitchBitsTakeHome({ bits: 1500 }), 15.00);
  assert.equal(E.twitchBitsTakeHome({ bits: 0 }), 0);
});

test('youtube super chat / sticker', () => {
  assert.equal(E.youtubeSuperTakeHome({ amount: 10, currency: 'USD' }), 7.00);
  assert.equal(E.youtubeSuperTakeHome({ amount: 8, currency: 'EUR' }), 6.05); // 8.64 × 0.70 = 6.048
  assert.equal(E.youtubeSuperTakeHome({ amount: 5, currency: 'USD' }), 3.50);
});

test('ko-fi donation / membership', () => {
  assert.equal(E.kofiTakeHome({ amount: 5, currency: 'USD' }), 4.75);
  assert.equal(E.kofiTakeHome({ amount: 10, currency: 'EUR' }), 10.26); // 10.80 × 0.95
  assert.equal(E.kofiTakeHome({ amount: 6, currency: 'USD' }), 5.70);
});

test('patreon pledge (cents)', () => {
  assert.equal(E.patreonTakeHome({ cents: 500, currency: 'USD' }), 4.25);   // 5 × 0.85
  assert.equal(E.patreonTakeHome({ cents: 1000, currency: 'EUR' }), 9.18);  // 10.80 × 0.85
});

test('streamlabs (paypal) take-home', () => {
  assert.equal(E.streamlabsTakeHome({ amount: 10, currency: 'USD' }), 9.41); // 9.71 − 0.30
  assert.equal(E.streamlabsTakeHome({ amount: 1, currency: 'USD' }), 0.67);  // 0.971 − 0.30
  assert.equal(E.streamlabsTakeHome({ amount: 0.20, currency: 'USD' }), 0);  // clamps at 0
  assert.equal(E.streamlabsTakeHome({ amount: 8, currency: 'EUR' }), 8.09);  // 8.64×0.971−0.30
});

test('stripeNet (native Stripe subs / donations / gift subs)', () => {
  assert.equal(E.stripeNet(10), 9.41);    // 10×0.971−0.30
  assert.equal(E.stripeNet(4.99), 4.55);  // supporter sub: 4.99×0.971−0.30 = 4.545 → 4.55
  assert.equal(E.stripeNet(0), 0);        // free → 0, never negative
  assert.equal(E.stripeNet(0.1), 0);      // max(0, …) floor
  assert.equal(E.stripeNet(undefined), 0);
});

test('takeHome dispatcher', () => {
  assert.equal(E.takeHome('twitch', 'giftbomb', { tier: 'tier 1', count: 5 }), 12.48);
  assert.equal(E.takeHome('twitch', 'bits', { bits: 1500 }), 15.00);
  assert.equal(E.takeHome('twitch', 'resub', { tier: 'tier 2' }), 5.00);
  assert.equal(E.takeHome('youtube', 'superchat', { amount: 10, currency: 'USD' }), 7.00);
  assert.equal(E.takeHome('youtube', 'membership-new', {}), 3.49);          // 4.99 base × 0.70
  assert.equal(E.takeHome('youtube', 'membership-gift', { count: 5 }), 17.47); // 4.99 × 0.70 × 5
  assert.equal(E.takeHome('youtube', 'membership-milestone', {}), 0);      // loyalty post, not a payment
  assert.equal(E.takeHome('kick', 'sub', {}), 4.74);                 // 4.99 × 0.95
  assert.equal(E.takeHome('kick', 'giftsub', { count: 5 }), 23.70);  // 4.99 × 0.95 × 5
  assert.equal(E.takeHome('kick', 'kicks', { kicks: 100 }), 0.95);   // 100 × 0.01 × 0.95
  assert.equal(E.takeHome('kofi', 'donation', { amount: 5, currency: 'USD' }), 4.75);
  assert.equal(E.takeHome('patreon', 'pledge-create', { cents: 500 }), 4.25);
  assert.equal(E.takeHome('streamlabs', 'donation', { amount: 10 }), 9.41);
  assert.equal(E.takeHome('unknown', 'x', {}), 0);
});

// An event whose native amount cannot be priced must be recognisable, so
// the alert path can keep it (stream.unpriced_support) instead of dropping it.
// takeHome() alone cannot say why it returned 0 — a milestone, a tiny
// Streamlabs tip under the fee, and a currency with no rate all read 0.
test('unpricedNative names an event whose currency the table cannot price', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(E.unpricedNative('youtube', 'superchat', { amount: 5000, currency: 'UNKNOWN' }),
      { amount: 5000, currency: 'UNKNOWN' });
    assert.deepEqual(E.unpricedNative('youtube', 'supersticker', { amount: 300, currency: 'XOF' }),
      { amount: 300, currency: 'XOF' });
    assert.deepEqual(E.unpricedNative('kofi', 'donation', { amount: 10, currency: 'zzz' }),
      { amount: 10, currency: 'ZZZ' });
    assert.deepEqual(E.unpricedNative('streamlabs', 'donation', { amount: 7, currency: 'XYZ' }),
      { amount: 7, currency: 'XYZ' });
    assert.deepEqual(E.unpricedNative('patreon', 'pledge-create', { cents: 500, currency: 'XYZ' }),
      { amount: 5, currency: 'XYZ' });
  } finally { console.error = quiet; }
});

test('unpricedNative is null for anything that priced, or carried no native amount', () => {
  assert.equal(E.unpricedNative('youtube', 'superchat', { amount: 5000, currency: 'ARS' }), null);
  assert.equal(E.unpricedNative('youtube', 'superchat', { amount: 5, currency: 'USD' }), null);
  assert.equal(E.unpricedNative('youtube', 'superchat', { amount: 0, currency: 'UNKNOWN' }), null);
  // Priced, but under Streamlabs' fixed fee: take-home is 0 for a KNOWN reason.
  assert.equal(E.unpricedNative('streamlabs', 'donation', { amount: 0.2, currency: 'USD' }), null);
  assert.equal(E.unpricedNative('youtube', 'membership-milestone', {}), null);
  assert.equal(E.unpricedNative('twitch', 'bits', { bits: 100 }), null);
  assert.equal(E.unpricedNative('native', 'donation', { amount: '$5.00' }), null);
});

// ── YouTube membership levels (owner-configured map; made-up level names) ─────
test('parseMembershipTiers: a JSON map of level → USD, case-insensitive; junk entries dropped', () => {
  const { parseMembershipTiers } = require('./economics');
  const quiet = console.error;
  console.error = () => {};
  try {
    const m = parseMembershipTiers('{"Bronze Club": 2.5, "  Gold Club ": 10, "Broken": "x", "Zero": 0}');
    assert.deepEqual([...m.entries()], [['bronze club', 2.5], ['gold club', 10]]);
    assert.equal(parseMembershipTiers('not json').size, 0);
    assert.equal(parseMembershipTiers('[1,2]').size, 0);
    assert.equal(parseMembershipTiers('').size, 0);
  } finally { console.error = quiet; }
});

test('youtubeMembershipUsd: a known level prices from the map; unknown or missing → base price with one log line', () => {
  const { youtubeMembershipUsd, parseMembershipTiers } = require('./economics');
  const tiers = parseMembershipTiers('{"Gold Club": 10}');
  const warned = [];
  const quiet = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    assert.equal(youtubeMembershipUsd('gold club', tiers), 10);
    assert.equal(warned.length, 0, 'a known level must not log');
    assert.equal(youtubeMembershipUsd('Mystery Club', tiers), 4.99);
    assert.equal(warned.length, 1);
    assert.equal(youtubeMembershipUsd(undefined, tiers), 4.99);
    // Said once per level per process: "no level" may already have been said by an earlier test.
    assert.ok(warned.length === 1 || warned.length === 2);
  } finally { console.warn = quiet; }
});

test('takeHome for a membership with no level is unchanged (base × 70%) — historical behaviour kept', () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert.equal(E.takeHome('youtube', 'membership-new', {}), E.round2(4.99 * 0.7));
    assert.equal(E.takeHome('youtube', 'membership-gift', { count: 3 }), E.round2(4.99 * 0.7 * 3));
    assert.equal(E.takeHome('youtube', 'membership-milestone', { level: 'Gold Club' }), 0);
  } finally { console.warn = quiet; }
});

test('YOUTUBE_MEMBERSHIP_TIERS from the environment prices a new member and a gift by level (real process)', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e',
    "const E=require('./economics');console.log(JSON.stringify([E.takeHome('youtube','membership-new',{level:'Gold Club'}),E.takeHome('youtube','membership-gift',{level:'gold club',count:2})]))"],
  { cwd: __dirname, env: { ...process.env, YOUTUBE_MEMBERSHIP_TIERS: '{"Gold Club": 10}', YOUTUBE_MEMBERSHIP_USD: '' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()), [7, 14]);
});

// A gift of N memberships at an unmapped level runs the level map N times; the warning is said
// once per level name per process, not N times.
test('an unmapped membership level is warned about once per level name, not per membership', () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const tiers = new Map([['gold', 9.99]]);
    for (let i = 0; i < 5; i++) E.youtubeMembershipUsd('F4 Unmapped Level', tiers);
    E.youtubeMembershipUsd('f4 unmapped level ', tiers);
    E.youtubeMembershipUsd('F4 Other Level', tiers);
    assert.equal(E.youtubeMembershipUsd('Gold', tiers), 9.99);
  } finally { console.warn = orig; }
  assert.equal(warned.filter((w) => /f4 unmapped level/.test(w)).length, 1);
  assert.equal(warned.filter((w) => /f4 other level/.test(w)).length, 1);
});
