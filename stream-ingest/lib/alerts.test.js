// Tests for normalizeTwitchEvent (raw tmi monetization → /alert payload).
// Run: node --test lib/alerts.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeTwitchEvent, normalizeYouTubeEvent, normalizeKickEvent, parseGiftCount, maskBannerName } from './alerts.js';

test('new sub (tier 1)', () => {
  const a = normalizeTwitchEvent({ kind: 'sub', userstate: { 'display-name': 'Alice', 'user-id': '1', login: 'alice', 'msg-param-sub-plan': '1000' }, message: 'yo' });
  assert.equal(a.eventType, 'sub');
  assert.equal(a.tier, 'tier 1');
  assert.equal(a.months, 1);
  assert.equal(a.label, 'subscribed');
  assert.equal(a.message, 'yo');
  // NO userImage from this side: a third-party picture host on the money path is
  // a dependency with no fallback. stream-api resolves the picture from Twitch
  // Helix by userId, so what this function owes is the ID, not a URL.
  assert.equal(a.userImage, undefined,
    'normalizeTwitchEvent is emitting a userImage again — the avatar is stream-api\'s ' +
    'job now (twitch-app.js); a URL built here means a third-party host is back on the alert path');
  assert.equal(a.userId, '1', 'userId is what stream-api resolves the avatar FROM — losing it loses the avatar');
});

test('new sub (tier 2 → label suffix)', () => {
  const a = normalizeTwitchEvent({ kind: 'sub', userstate: { 'display-name': 'Al', 'msg-param-sub-plan': '2000' } });
  assert.equal(a.tier, 'tier 2');
  assert.equal(a.label, 'subscribed · Tier 2');
});

test('resub with months + streak', () => {
  const a = normalizeTwitchEvent({ kind: 'resub', userstate: { 'display-name': 'Bob', 'msg-param-sub-plan': '3000', 'msg-param-cumulative-months': '12', 'msg-param-streak-months': '5' } });
  assert.equal(a.eventType, 'resub');
  assert.equal(a.tier, 'tier 3');
  assert.equal(a.months, 12);
  assert.equal(a.label, 'resubscribed · Tier 3 · month 12 · 5 streak');
});

test('gift sub (single)', () => {
  const a = normalizeTwitchEvent({ kind: 'subgift', userstate: { 'display-name': 'Gifter', 'msg-param-sub-plan': '1000', 'msg-param-recipient-display-name': 'Recip', 'msg-param-gift-months': '1' } });
  assert.equal(a.eventType, 'giftsub');
  assert.equal(a.recipient, 'Recip');
  assert.equal(a.months, 1);
  assert.equal(a.label, 'gifted a sub to Recip');
});

test('gift sub inside a bomb is suppressed', () => {
  const a = normalizeTwitchEvent({ kind: 'subgift', userstate: { 'msg-param-community-gift-id': '999', 'msg-param-sub-plan': '1000', 'msg-param-recipient-display-name': 'R' } });
  assert.equal(a, null);
});

test('mystery gift bomb (count from numbOfSubs)', () => {
  const a = normalizeTwitchEvent({ kind: 'submysterygift', numbOfSubs: 5, userstate: { 'display-name': 'Bomber', 'msg-param-sub-plan': '1000' } });
  assert.equal(a.eventType, 'giftbomb');
  assert.equal(a.count, 5);
  assert.equal(a.label, 'gifted 5 subs');
});

test('mystery gift bomb (count from mass-gift-count, single)', () => {
  const a = normalizeTwitchEvent({ kind: 'submysterygift', userstate: { 'display-name': 'B', 'msg-param-mass-gift-count': '1', 'msg-param-sub-plan': '2000' } });
  assert.equal(a.count, 1);
  assert.equal(a.label, 'gifted 1 sub · Tier 2');
});

test('cheer (bits)', () => {
  const a = normalizeTwitchEvent({ kind: 'cheer', userstate: { 'display-name': 'Cheerer', bits: '100' }, message: 'cheer100 nice' });
  assert.equal(a.eventType, 'bits');
  assert.equal(a.bits, 100);
  assert.equal(a.label, 'cheered');
});

test('prime paid upgrade', () => {
  const a = normalizeTwitchEvent({ kind: 'primepaidupgrade', userstate: { 'display-name': 'P', 'msg-param-sub-plan': '1000' } });
  assert.equal(a.eventType, 'prime-upgrade');
  assert.equal(a.label, 'upgraded Prime → Tier 1');
});

test('pay it forward (with recipient)', () => {
  const a = normalizeTwitchEvent({ kind: 'payitforward', userstate: { 'display-name': 'PIF', 'msg-param-recipient-display-name': 'Lucky' } });
  assert.equal(a.eventType, 'pay-it-forward');
  assert.equal(a.label, 'paid it forward to Lucky');
});

test('unknown kind → null', () => {
  assert.equal(normalizeTwitchEvent({ kind: 'whatever', userstate: {} }), null);
});

test('youtube super chat (USD)', () => {
  const a = normalizeYouTubeEvent({ kind: 'superchat', author: 'YTFan', amount: '$5.00', message: 'nice stream' });
  assert.equal(a.eventType, 'superchat');
  assert.equal(a.amount, 5);
  assert.equal(a.currency, 'USD');
  assert.equal(a.message, 'nice stream');
  assert.equal(a.label, 'super chat');
});

test('youtube super chat (other currencies + thousands)', () => {
  assert.deepEqual(
    (({ amount, currency }) => ({ amount, currency }))(normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: '€10.00' })),
    { amount: 10, currency: 'EUR' });
  assert.equal(normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: '₹1,000.00' }).currency, 'INR');
  assert.equal(normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: '₹1,000.00' }).amount, 1000);
  assert.equal(normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: 'CA$20.00' }).currency, 'CAD');
});

test('youtube super chat (empty/garbage amount → 0, still a valid alert)', () => {
  // Selector drift / degraded shell yields an empty #purchase-amount. The alert
  // must still fire (overlay + card) — only the $ credit is lost.
  const empty = normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: '' });
  assert.equal(empty.eventType, 'superchat');
  assert.equal(empty.amount, 0);
  // No symbol at all is not evidence of dollars: an empty string names no
  // currency, so it is UNKNOWN (and amount 0 credits nothing either way).
  assert.equal(empty.currency, 'UNKNOWN');
  const garbage = normalizeYouTubeEvent({ kind: 'superchat', author: 'a', amount: 'Free!' });
  assert.equal(garbage.amount, 0);
  assert.equal(normalizeYouTubeEvent({ kind: 'supersticker', author: 'a', amount: '' }).amount, 0);
});

test('youtube super sticker', () => {
  const a = normalizeYouTubeEvent({ kind: 'supersticker', author: 'S', amount: '$2.00' });
  assert.equal(a.eventType, 'supersticker');
  assert.equal(a.amount, 2);
  assert.equal(a.label, 'super sticker');
});

test('youtube membership new vs milestone', () => {
  assert.equal(normalizeYouTubeEvent({ kind: 'membership', author: 'M', header: 'Welcome!' }).eventType, 'membership-new');
  const ms = normalizeYouTubeEvent({ kind: 'membership', author: 'M', header: 'Member for 3 months' });
  assert.equal(ms.eventType, 'membership-milestone');
  assert.equal(ms.label, 'member · month 3');
});

test('youtube membership gift', () => {
  const a = normalizeYouTubeEvent({ kind: 'membership-gift', author: 'Gifter', count: 5 });
  assert.equal(a.eventType, 'membership-gift');
  assert.equal(a.count, 5);
  assert.equal(a.label, 'gifted 5 memberships');
});

test('kick sub / resub', () => {
  const s = normalizeKickEvent({ kind: 'sub', username: 'KFan', months: 1 });
  assert.equal(s.platform, 'kick');
  assert.equal(s.eventType, 'sub');
  assert.equal(s.label, 'subscribed');
  const r = normalizeKickEvent({ kind: 'sub', username: 'KFan', months: 6 });
  assert.equal(r.label, 'resubscribed · 6 months');
});

test('kick gifted subs (count + single recipient)', () => {
  const g = normalizeKickEvent({ kind: 'giftsub', gifter: 'KGifter', count: 5 });
  assert.equal(g.eventType, 'giftsub');
  assert.equal(g.username, 'KGifter');
  assert.equal(g.count, 5);
  assert.equal(g.label, 'gifted 5 subs');
  const one = normalizeKickEvent({ kind: 'giftsub', gifter: 'KGifter', count: 1, recipient: 'Lucky' });
  assert.equal(one.label, 'gifted 1 sub');
  assert.equal(one.recipient, 'Lucky');
});

test('kick Kicks tipping', () => {
  const k = normalizeKickEvent({ kind: 'kicks', username: 'Tipper', kicks: 100 });
  assert.equal(k.eventType, 'kicks');
  assert.equal(k.kicks, 100);
  assert.equal(k.label, 'sent 100 Kicks');
});

test('kick unknown kind → null', () => {
  assert.equal(normalizeKickEvent({ kind: 'whatever' }), null);
  assert.equal(normalizeKickEvent(null), null);
});

// ── eventId: what makes a retried POST /alert legal ─────────────────────────
// postAlert retries a failed delivery (a paid event is not droppable), and
// stream-api dedups on eventId — so the id must be minted ONCE per event,
// here in the normalizer, and reused verbatim by every retry. Prefer the
// platform's own id when it sends one (that also absorbs a platform
// re-delivering the same event); otherwise mint a process-unique one.

test('every normalizer stamps an eventId, preferring the platform own id', () => {
  const tw = normalizeTwitchEvent({ kind: 'sub',
    userstate: { 'display-name': 'A', id: 'usernotice-123', 'msg-param-sub-plan': '1000' } });
  assert.equal(tw.eventId, 'twitch:usernotice-123');
  const yt = normalizeYouTubeEvent({ kind: 'superchat', author: 'B', amount: '$5.00', id: 'yt-renderer-9' });
  assert.equal(yt.eventId, 'youtube:yt-renderer-9');
  const k = normalizeKickEvent({ kind: 'kicks', username: 'C', kicks: 100, id: 'kick-evt-7' });
  assert.equal(k.eventId, 'kick:kick-evt-7');
});

test('an event without a platform id still mints a unique eventId', () => {
  const a = normalizeTwitchEvent({ kind: 'cheer', userstate: { 'display-name': 'A', bits: '100' }, message: '' });
  const b = normalizeTwitchEvent({ kind: 'cheer', userstate: { 'display-name': 'A', bits: '100' }, message: '' });
  assert.ok(a.eventId && b.eventId, 'a missing platform id must not mean a missing eventId — retries would be illegal');
  assert.notEqual(a.eventId, b.eventId,
    'two identical-looking cheers minted the same id — the second REAL event would be deduped away');
});

// ── a currency the table does not know is NEVER dollars ─────────────────────
// The scraper reads YouTube in en-US, where a currency with no short symbol is
// written as its ISO code ("ARS 5,000.00") and a few with an uncommon symbol
// ("CN¥100.00", "₫100,000"). A fallback to 'USD' would credit ARS 5,000 (about
// $5) as $3,500 on the bar, the timer, the sponsor pool and the ledger.
// stream-api's toUSD credits $0 and logs for a code it cannot price, so the
// code must reach it.

test('an ISO-prefixed amount keeps its own code, never USD', () => {
  for (const [raw, code, amount] of [
    ['ARS 5,000.00', 'ARS', 5000], ['COP 20,000', 'COP', 20000], ['HUF 2,000', 'HUF', 2000],
    ['SEK 50.00', 'SEK', 50],
  ]) {
    const a = normalizeYouTubeEvent({ kind: 'superchat', author: 'casey', amount: raw });
    assert.equal(a.currency, code, `${raw} was labelled ${a.currency}`);
    assert.equal(a.amount, amount);
  }
});

test('the uncommon symbols are mapped', () => {
  for (const [raw, code] of [['CN¥100.00', 'CNY'], ['₫100,000', 'VND'], ['E£500.00', 'EGP'], ['₴200.00', 'UAH']]) {
    assert.equal(normalizeYouTubeEvent({ kind: 'superchat', author: 'casey', amount: raw }).currency, code, raw);
  }
});

test('an unmapped symbol is UNKNOWN — never USD — and the raw text rides along', () => {
  for (const raw of ['F CFA 5,000', '¤12.00', 'Cg. 5,000.00', '5,000']) {
    const a = normalizeYouTubeEvent({ kind: 'superchat', author: 'casey', amount: raw });
    assert.notEqual(a.currency, 'USD', `${raw} was credited as dollars`);
    assert.equal(a.currency, 'UNKNOWN', raw);
    assert.equal(a.amountText, raw, 'the raw string is what the alert shows and what reconciliation reads');
  }
  const st = normalizeYouTubeEvent({ kind: 'supersticker', author: 'casey', amount: 'F CFA 1,000' });
  assert.equal(st.currency, 'UNKNOWN');
  assert.equal(st.amountText, 'F CFA 1,000');
});

// The table cannot drift from what stream-api can price: every currency
// stream-api's toUSD knows is formatted the way the scraper sees it (en-US,
// Intl) and must come back as exactly that code. Derived, not listed, so a
// code added to CURRENCY_RATES is covered the day it lands.
test('every currency stream-api can price round-trips through its en-US format', () => {
  const economics = createRequire(import.meta.url)('../../stream-api/economics.js');
  const quiet = console.error;
  const priced = [];
  console.error = () => {};
  try {
    for (const code of Intl.supportedValuesOf('currency')) {
      if (economics.toUSD(1e6, code) > 0) priced.push(code);
    }
  } finally { console.error = quiet; }
  // Vacuity anchor: if the require or the probe broke, `priced` is empty and the
  // loop below proves nothing.
  assert.ok(priced.length >= 50 && priced.includes('USD') && priced.includes('VND'),
    `only ${priced.length} priced codes found — the probe of stream-api's table is broken`);
  for (const code of priced) {
    const raw = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(5000);
    const a = normalizeYouTubeEvent({ kind: 'superchat', author: 'casey', amount: raw });
    assert.equal(a.currency, code, `${code} formats as "${raw}" and parsed as ${a.currency}`);
    assert.equal(a.amount, 5000, `${code} "${raw}" amount`);
  }
  // And no currency at all — priced or not — may come back as dollars unless it IS dollars.
  for (const code of Intl.supportedValuesOf('currency')) {
    if (code === 'USD') continue;
    const raw = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(5000);
    assert.notEqual(normalizeYouTubeEvent({ kind: 'superchat', author: 'casey', amount: raw }).currency, 'USD',
      `${code} "${raw}" was labelled USD`);
  }
});

// ── gifted memberships count from the words next to the count ───────────────
// A /gifted\s+(\d+)/ match fails on the wording YouTube uses and silently
// credits every multi-gift as one. The count must come from the number
// ADJACENT to the gift wording, never the first number in the text, which may
// be the donor's own name.

test('parseGiftCount reads the count next to the gift wording', () => {
  for (const [text, n] of [
    ['Sent 5 Gadget Live gift memberships', 5],
    ['sent 20 Gadget gift memberships', 20],
    ['Gifted 3 Gadget memberships', 3],
    ['Viewer2026 sent 5 gift memberships', 5],
    ['Viewer2026 gifted 10 Gadget Live memberships', 10],
    ['Sent 1 Gadget gift membership', 1],
    ['Sent 50 Team 10 gift memberships', 50],
  ]) {
    assert.deepEqual(parseGiftCount(text), { count: n, verified: true }, text);
  }
});

// The donor picks their own name and it comes first, so a name can carry the
// gift wording: "Sent 500 x" + "gifted 1 membership" must be 1, not 500.
test('parseGiftCount: a donor name containing the gift wording cannot set the count', () => {
  assert.deepEqual(parseGiftCount('Sent 500 x gifted 1 membership', 'Sent 500 x'), { count: 1, verified: true });
  // Without the author to cut off, the LAST "sent/gifted N" — YouTube's own — still wins.
  assert.deepEqual(parseGiftCount('Sent 500 x gifted 1 membership'), { count: 1, verified: true });
  assert.deepEqual(parseGiftCount('gifted 20 memberships lol sent 5 Gadget gift memberships'), { count: 5, verified: true });
  // Wording at the start but not at the end is not the banner's shape.
  assert.deepEqual(parseGiftCount('Sent 5 Gadget gift memberships to everyone'), { count: 1, verified: false });
});

test('parseGiftCount: a count above YouTube\'s largest gift (50) is not trusted', () => {
  assert.deepEqual(parseGiftCount('Sent 51 Gadget gift memberships'), { count: 1, verified: false });
  assert.deepEqual(parseGiftCount('Sent 1,000 Team 10 gift memberships'), { count: 1, verified: false });
});

test('parseGiftCount never takes a number that is not the gift count', () => {
  for (const text of ['Viewer2026 is a member', 'Viewer2026', '', 'Thanks to 50 members!', 'Sent 5 stickers', undefined]) {
    assert.deepEqual(parseGiftCount(text), { count: 1, verified: false }, String(text));
  }
});

test('a gift banner with an unreadable count credits 1, flagged unverified, and logs the wording WITHOUT the donor name', () => {
  const warned = [];
  const orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  let a;
  try {
    a = normalizeYouTubeEvent({ kind: 'membership-gift', author: 'Viewer2026', primary: 'Viewer2026 did something new' });
  } finally { console.warn = orig; }
  assert.equal(a.count, 1, 'an unreadable count must never be 0 — a real gift happened');
  assert.equal(a.countUnverified, true);
  const line = warned.join('\n');
  assert.match(line, /did something new/, "YouTube's wording must still be logged so the next stream captures it");
  assert.doesNotMatch(line, /Viewer2026/, 'the donor name reached the journal');
});

test('maskBannerName: the author anywhere, or an unknown name before YouTube\'s own verb', () => {
  assert.equal(maskBannerName('Casey gifted 900 Gadget memberships', 'casey'), '<name> gifted 900 Gadget memberships');
  assert.equal(maskBannerName('Sent 900 x gifted 1 membership', ''), '<name> gifted 1 membership');
  assert.equal(maskBannerName('Casey Jones did a thing', ''), '<unrecognised banner, 23 chars — wording withheld: no author to mask>');
  assert.equal(maskBannerName('', 'casey'), '');
  assert.ok(maskBannerName('x'.repeat(500) + ' gifted 3 memberships', 'y').length <= 240, 'the logged text is bounded');
});

test('a gift banner carries its parsed count through normalizeYouTubeEvent', () => {
  const a = normalizeYouTubeEvent({ kind: 'membership-gift', author: 'Viewer2026', primary: 'Sent 5 Gadget gift memberships' });
  assert.equal(a.count, 5);
  assert.equal(a.countUnverified, undefined);
  assert.equal(a.label, 'gifted 5 memberships');
});

// ── YouTube membership LEVEL (made-up level names) ───────────────────────────
import { membershipLevel } from './alerts.js';

test('membership level: "Welcome to <level>!" on a new member', () => {
  const a = normalizeYouTubeEvent({ kind: 'membership', author: 'casey', header: 'Welcome to Gold Club!', subtext: 'Welcome to Gold Club!', primaryHeader: '' });
  assert.equal(a.eventType, 'membership-new');
  assert.equal(a.level, 'Gold Club');
});

test('membership level: a milestone\'s subtext is the level', () => {
  assert.equal(membershipLevel({ kind: 'membership', subtext: 'Bronze Club', primaryHeader: 'Member for 6 months' }), 'Bronze Club');
});

test('membership level: a gift banner in either wording', () => {
  assert.equal(membershipLevel({ kind: 'membership-gift', author: 'casey', primary: 'casey gifted 5 Gold Club memberships' }), 'Gold Club');
  assert.equal(membershipLevel({ kind: 'membership-gift', author: '', primary: 'Sent 3 Gold Club gift memberships' }), 'Gold Club');
  const g = normalizeYouTubeEvent({ kind: 'membership-gift', author: 'casey', primary: 'casey gifted 2 Gold Club memberships' });
  assert.equal(g.count, 2);
  assert.equal(g.level, 'Gold Club');
});

test('membership level: unrecognised wording is simply no level (the base price applies)', () => {
  const a = normalizeYouTubeEvent({ kind: 'membership', author: 'casey', header: 'something new', subtext: 'something new', primaryHeader: '' });
  assert.equal(a.level, undefined);
  assert.equal(membershipLevel({ kind: 'membership-gift', primary: 'a banner nobody has seen' }), '');
});

// ── Twitch multi-month prepaid resubs: logged, credit unchanged ────────────────
test('a multi-month resub logs its raw tag set once, at info, with no name; the payload is unchanged', () => {
  const lines = [];
  const real = console.info;
  console.info = (...a) => lines.push(a.join(' '));
  const u = { 'display-name': 'Alice', 'user-id': '1', id: 'mm-evt-1', 'msg-param-sub-plan': '1000',
    'msg-param-cumulative-months': '7', 'msg-param-multimonth-duration': '3', 'msg-param-multimonth-tenure': '1', 'msg-param-was-gifted': 'false' };
  let a;
  let b;
  try {
    a = normalizeTwitchEvent({ kind: 'resub', userstate: u, message: 'hi' });
    b = normalizeTwitchEvent({ kind: 'resub', userstate: u, message: 'hi' }); // the same event again
  } finally { console.info = real; }
  assert.equal(lines.length, 1, 'the multi-month line must be logged once per event');
  assert.match(lines[0], /multi-month resub event=twitch:mm-evt-1/);
  assert.match(lines[0], /"msg-param-multimonth-duration":"3"/);
  assert.doesNotMatch(lines[0], /Alice/);
  assert.equal(a.months, 7, 'credit logic changed');
  assert.deepEqual(a, b);
});

test('an ordinary resub logs nothing', () => {
  const lines = [];
  const real = console.info;
  console.info = (...a) => lines.push(a.join(' '));
  try {
    normalizeTwitchEvent({ kind: 'resub', userstate: { 'display-name': 'Bo', 'user-id': '2', id: 'mm-evt-2', 'msg-param-cumulative-months': '4' } });
  } finally { console.info = real; }
  assert.equal(lines.length, 0);
});
