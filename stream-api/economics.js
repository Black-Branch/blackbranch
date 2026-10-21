// Monetization economics for the unified alert system (stream-api).
//
// `takeHome` is the single source of $ truth: a wrong constant here corrupts BOTH
// the support bar AND logged revenue in `support_events`. Take-home is net to the
// operator after platform + payment-processing fees; the display amount is what the
// alert overlay shows.
//
// The tier tables were ported from an earlier normalizer, which is why they read the
// way they do; this file is the definition, so change it on evidence.
//
// Pure + side-effect-free → unit-tested in
// `economics.test.js`, and the accounting model is pinned by `money-policy.test.js`.

'use strict';

// ── Twitch sub tiers (USD gross). Prime is billed as a Tier 1. ──────────────
const TWITCH_TIERS = { 'tier 1': 4.99, 'tier 2': 9.99, 'tier 3': 24.99, prime: 4.99 };

// ── Revenue-share / fee multipliers ────────────────────────────────────────
const SHARE = {
  twitch: 0.50,     // Twitch 50% revenue share (subs, gifts, upgrades)
  bitsPerBit: 0.01, // $0.01 per bit (flat)
  youtube: 0.70,    // Google takes 30% on Super Chat / Super Sticker
  kofi: 0.95,       // Ko-fi: no platform fee, ~5% processing
  patreon: 0.85,    // Patreon 8% + ~7% processing ≈ 15% total
  kick: 0.95,       // Kick 95% creator split — confirmed from KPP dashboard
                    //   ($4.74 take-home / $4.99 sub = 0.95)
};
// Kick sub price (gross USD) + Kicks tipping rate. Confirmed: 1 sub = $4.99 → $4.74
// take-home. "Kicks" (tipping currency) ≈ $0.01 each — an estimate, configurable.
const KICK_SUB_USD = Number(process.env.KICK_SUB_USD || 4.99);
const KICK_USD_PER_KICK = Number(process.env.KICK_USD_PER_KICK || 0.01);
// Streamlabs (PayPal): 2.9% + $0.30 fixed → max(0, usd*0.971 - 0.30)
const STREAMLABS_PCT = 0.971;
const STREAMLABS_FIXED = 0.30;
// YouTube memberships carry NO scraped price, but a new/gifted member IS paying —
// so credit an estimated base tier (×70% like super chats) so they fill the timer.
// Configurable; recurring renewals are silent (no chat event) and can't be caught.
const YOUTUBE_MEMBERSHIP_USD = Number(process.env.YOUTUBE_MEMBERSHIP_USD || 4.99);
// Optional per-level prices: YOUTUBE_MEMBERSHIP_TIERS is JSON, level name → gross USD, e.g.
// {"<level name>": 4.99, "<other level>": 9.99}. stream-ingest reads the level name off the
// membership banner and sends it as `level`; a level the map does not name (or no level at
// all) is credited at YOUTUBE_MEMBERSHIP_USD, with one log line. Names are matched
// case-insensitively and trimmed. Read once, at load (a change needs a restart).
const YOUTUBE_MEMBERSHIP_TIERS = parseMembershipTiers(process.env.YOUTUBE_MEMBERSHIP_TIERS);

/** level name (lower-cased, trimmed) → USD; a malformed variable is an empty map, said once. */
function parseMembershipTiers(raw) {
  const out = new Map();
  if (!raw || !String(raw).trim()) return out;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    console.error('[economics] YOUTUBE_MEMBERSHIP_TIERS is not valid JSON — every level is credited at the base price: %s', e.message);
    return out;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    console.error('[economics] YOUTUBE_MEMBERSHIP_TIERS must be a JSON object of level name → USD — ignored');
    return out;
  }
  for (const [name, usd] of Object.entries(obj)) {
    const n = Number(usd);
    const key = String(name).trim().toLowerCase();
    if (key && Number.isFinite(n) && n > 0) out.set(key, n);
    else console.error('[economics] YOUTUBE_MEMBERSHIP_TIERS entry %j has no usable price — ignored', name);
  }
  return out;
}

/**
 * The gross USD price of one YouTube membership at `level`, from the owner's map, else the base
 * price. `tiers` is injectable for tests; production reads the env map above.
 */
// Said once per level name per process: a gift runs this once per event, and every gift at an
// unmapped level would otherwise repeat the same line. Bounded: past the cap, nothing new
// is remembered and the line is simply said again.
const warnedLevels = new Set();
const WARNED_LEVELS_MAX = 200;
function youtubeMembershipUsd(level, tiers = YOUTUBE_MEMBERSHIP_TIERS) {
  const key = typeof level === 'string' ? level.trim().toLowerCase() : '';
  if (key && tiers.has(key)) return tiers.get(key);
  if (!warnedLevels.has(key)) {
    if (warnedLevels.size < WARNED_LEVELS_MAX) warnedLevels.add(key);
    console.warn('[economics] YouTube membership level %s is not in YOUTUBE_MEMBERSHIP_TIERS — credited at the base price $%s (said once per level)',
      key ? JSON.stringify(key) : '(none on the banner)', YOUTUBE_MEMBERSHIP_USD);
  }
  return YOUTUBE_MEMBERSHIP_USD;
}

// Ko-fi event types that are a PURCHASE (a shop sale, a commission), not support: they are
// celebrated but never credited — no ledger row, no bar, no timer.
const KOFI_PURCHASES = new Set(['shop-order', 'commission']);

// ── Static FX → USD ─────────────────────────────────────────────────────────
// Approximate USD-per-unit rates. These are a static heuristic, not a live feed —
// they drift, and a few points of FX error on the support bar is acceptable. What
// is NOT acceptable is an unknown code being treated as USD, so anything missing
// here credits $0 and logs loudly (see toUSD). Extend the table when that fires.
const CURRENCY_RATES = {
  USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.64, NZD: 0.60, JPY: 0.0066,
  KRW: 0.00072, INR: 0.012, BRL: 0.18, MXN: 0.05, CHF: 1.13, SEK: 0.095,
  NOK: 0.092, DKK: 0.145, HKD: 0.13, SGD: 0.74, PLN: 0.25, RUB: 0.011,
  TRY: 0.031, THB: 0.028,
  // The rest of the currencies Ko-fi / PayPal / YouTube commonly settle in;
  // without an entry each one would credit $0 (see toUSD).
  CZK: 0.043, HUF: 0.0026, RON: 0.22, BGN: 0.55, ISK: 0.0072, UAH: 0.024,
  RSD: 0.0092, ZAR: 0.055, ILS: 0.27, AED: 0.27, SAR: 0.267, QAR: 0.275,
  EGP: 0.020, MAD: 0.10, NGN: 0.00065, KES: 0.0077,
  CNY: 0.14, TWD: 0.031, PHP: 0.017, IDR: 0.000061, VND: 0.000039, MYR: 0.22,
  PKR: 0.0036, BDT: 0.0084, LKR: 0.0034, NPR: 0.0075,
  CLP: 0.001, COP: 0.00024, ARS: 0.001, PEN: 0.27, UYU: 0.025,
};

// Round to cents, half-up. The 1e-9 nudge lifts exact .xx5 midpoints that binary
// floats under-represent (e.g. 12.495 stored as 12.49499999…) so they round up
// deterministically; it is far too small to disturb any real cent boundary.
// Conventional half-up on doubles, not banker's rounding: differences are ≤1¢ on
// rare exact-midpoint values — immaterial to the support bar and the display amount.
function round2(n) {
  return Math.round((Number(n) + 1e-9) * 100) / 100;
}

function tierAmount(tier) {
  const key = String(tier || '').toLowerCase().trim();
  return TWITCH_TIERS[key] ?? TWITCH_TIERS['tier 1'];
}

// Convert a gross amount in `currency` to USD. Rounds to cents.
//
// An unknown currency returns 0 — deliberately NOT a passthrough.
//
// A passthrough would treat an unknown code as if it were USD, which silently multiplies the support bar by the inverse
// of the real rate. Most currencies missing from this table are LOW-value per unit,
// so the error is enormous and always in the wrong direction: ₫100,000 (~$4) would
// credit $100,000.
//
// Returning 0 degrades safely instead. The alert still broadcasts (alert.js only
// gates the bar/timer credit and the "$" label on takeHome > 0), so the viewer's
// event is still celebrated — it just does not move the money totals until the
// currency is added below. Under-crediting is recoverable; over-crediting corrupts
// the support bar, the timer, and stream.support_events with no audit trail.
function toUSD(amount, currency) {
  const amt = Number(amount) || 0;
  const code = String(currency || 'USD').toUpperCase().trim();
  if (code === 'USD') return round2(amt);
  const rate = CURRENCY_RATES[code];
  if (rate == null) {
    console.error(
      '[economics] UNKNOWN CURRENCY %s (amount %s) — crediting $0. Add it to CURRENCY_RATES.',
      code, amt
    );
    return 0;
  }
  return round2(amt * rate);
}

function formatUSD(v) {
  return '$' + (Number(v) || 0).toFixed(2);
}

// ── Per-event take-home (USD, number) ───────────────────────────────────────
// Twitch new sub / gift sub: tier × months × 50%.
function twitchSubTakeHome({ tier, months = 1 } = {}) {
  return round2(tierAmount(tier) * Math.max(1, Number(months) || 1) * SHARE.twitch);
}
// Twitch single-tier events: resub, gift-paid-upgrade, pay-it-forward, prime-upgrade.
function twitchFlatTakeHome({ tier } = {}) {
  return round2(tierAmount(tier) * SHARE.twitch);
}
// Twitch gift bomb: tier × count × 50%.
function twitchGiftbombTakeHome({ tier, count = 1 } = {}) {
  return round2(tierAmount(tier) * Math.max(1, Number(count) || 1) * SHARE.twitch);
}
// Twitch cheer: $0.01 per bit.
function twitchBitsTakeHome({ bits = 0 } = {}) {
  return round2((Number(bits) || 0) * SHARE.bitsPerBit);
}
// YouTube Super Chat / Super Sticker: usd × 70%.
function youtubeSuperTakeHome({ amount, currency } = {}) {
  return round2(toUSD(amount, currency) * SHARE.youtube);
}
// Ko-fi donation / membership: usd × 95%.
function kofiTakeHome({ amount, currency } = {}) {
  return round2(toUSD(amount, currency) * SHARE.kofi);
}
// Patreon pledge (amount arrives as integer cents): (cents/100) × rate × 85%.
function patreonTakeHome({ cents, currency } = {}) {
  const usd = toUSD((Number(cents) || 0) / 100, currency);
  return round2(usd * SHARE.patreon);
}
// Streamlabs (PayPal tip): max(0, usd × 0.971 − $0.30).
function streamlabsTakeHome({ amount, currency } = {}) {
  const usd = toUSD(amount, currency);
  return round2(Math.max(0, usd * STREAMLABS_PCT - STREAMLABS_FIXED));
}
// Native Stripe (subs / donations / gift subs): 2.9% + $0.30, identical to the
// PayPal/Streamlabs fee. Input is GROSS USD (a number); returns net take-home USD.
// Single home for the Stripe-fee math used by /chat/event (sub/gift/donation).
function stripeNet(usdGross) {
  return round2(Math.max(0, (Number(usdGross) || 0) * STREAMLABS_PCT - STREAMLABS_FIXED));
}

// Dispatcher keyed on the catalog (platform, eventType). Returns take-home USD
// (number). YouTube memberships carry no payment data → 0. Unknown pairs → 0.
function takeHome(platform, eventType, params = {}) {
  const p = String(platform || '').toLowerCase();
  const e = String(eventType || '').toLowerCase();
  if (p === 'twitch') {
    switch (e) {
      case 'sub':
      case 'giftsub': return twitchSubTakeHome(params);
      case 'giftbomb': return twitchGiftbombTakeHome(params);
      case 'bits': return twitchBitsTakeHome(params);
      case 'resub':
      case 'gift-paid-upgrade':
      case 'pay-it-forward':
      case 'prime-upgrade': return twitchFlatTakeHome(params);
      default: return 0;
    }
  }
  if (p === 'youtube') {
    if (e === 'superchat' || e === 'supersticker') return youtubeSuperTakeHome(params);
    // A NEW signup or a GIFT is a real payment (estimated base price, ×70%); a
    // milestone is just a loyalty post (the monthly renewal is silent) → 0.
    if (e === 'membership-new') return round2(youtubeMembershipUsd(params.level) * SHARE.youtube);
    if (e === 'membership-gift') return round2(youtubeMembershipUsd(params.level) * SHARE.youtube * Math.max(1, Number(params.count) || 1));
    return 0; // membership-milestone / -upgrade: no fresh payment
  }
  if (p === 'kick') {
    // Subs + gifted subs at $4.99 × 95% = $4.74 each (gifts scale by count);
    // Kicks tipping at the configured per-Kick rate × 95%.
    if (e === 'sub') return round2(KICK_SUB_USD * SHARE.kick);
    if (e === 'giftsub') return round2(KICK_SUB_USD * SHARE.kick * Math.max(1, Number(params.count) || 1));
    if (e === 'kicks') return round2((Number(params.kicks) || 0) * KICK_USD_PER_KICK * SHARE.kick);
    return 0;
  }
  if (p === 'kofi') return KOFI_PURCHASES.has(e) ? 0 : kofiTakeHome(params);
  if (p === 'patreon') return patreonTakeHome(params);
  if (p === 'streamlabs') return streamlabsTakeHome(params);
  return 0;
}

// The native amount of a payment this module could NOT price, or null.
//
// takeHome() returns 0 for very different reasons — a milestone that is no
// payment, a tip smaller than Streamlabs' fixed fee, and a currency with no
// rate in CURRENCY_RATES — and only the last one is money that arrived and was
// not counted. alert.js asks this to tell them apart, and keeps such an event
// in stream.unpriced_support for a person to reconcile instead of dropping it.
// Covers exactly the take-home branches above that go through toUSD.
function unpricedNative(platform, eventType, params = {}) {
  const p = String(platform || '').toLowerCase();
  const e = String(eventType || '').toLowerCase();
  let amount;
  if (p === 'youtube' && (e === 'superchat' || e === 'supersticker')) amount = Number(params.amount);
  else if (p === 'kofi' && KOFI_PURCHASES.has(e)) return null; // a purchase: priced or not, never support
  else if (p === 'kofi' || p === 'streamlabs') amount = Number(params.amount);
  else if (p === 'patreon') amount = (Number(params.cents) || 0) / 100;
  else return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = String(params.currency || 'USD').toUpperCase().trim();
  if (currency === 'USD' || CURRENCY_RATES[currency] != null) return null;
  return { amount, currency };
}

// The RATE TABLES are deliberately not exported: TWITCH_TIERS, SHARE and
// CURRENCY_RATES are the inputs this module exists to apply, and nothing
// outside it read them. A second reader of a rate table is a second place the
// split can be computed, which is the shape `no_column_for_a_derivable_invariant`
// warns about — one writer cannot drift from itself. Ask this module for a
// take-home; do not do the arithmetic again elsewhere.
module.exports = {
  round2,
  tierAmount,
  toUSD,
  formatUSD,
  twitchSubTakeHome,
  twitchFlatTakeHome,
  twitchGiftbombTakeHome,
  twitchBitsTakeHome,
  youtubeSuperTakeHome,
  kofiTakeHome,
  patreonTakeHome,
  streamlabsTakeHome,
  stripeNet,
  takeHome,
  unpricedNative,
  youtubeMembershipUsd,
  parseMembershipTiers,
};
