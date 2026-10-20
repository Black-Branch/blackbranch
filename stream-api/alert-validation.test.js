// POST /alert validation + the take-home money guard.
//
// The rule that matters here is what is NOT validated. There is no single amount
// field across producers — Patreon sends `cents`, Twitch `bits`, Kick `kicks`,
// Ko-fi/YouTube/Streamlabs `amount`, and sub/gift events carry only
// `months`/`count`/`tier` with take-home derived server-side. A validator that
// demanded "an amount" would silently drop real donations, which is strictly worse
// than no validation at all. So every real producer payload below is asserted to
// still pass, and that list is the point of this file.
//
// Producers:
//   POST /alert   ← stream-ingest normalizers (twitch, youtube, kick) + tools/simulate-event.js
//   dispatch()    ← webhooks.js Ko-fi, Patreon, and Streamlabs — IN-PROCESS, they never
//                   touch the route, which is why the money guard lives in alert.js
//
// Run: node --test alert-validation.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlert } = require('./alert.js');
const { createMoney } = require('./money.js');

// ── route harness ───────────────────────────────────────────────────────────

function routeHarness() {
  const dispatched = [];
  const alert = { dispatch: async (input) => { dispatched.push(input); return { ok: true }; } };
  const routes = new Map();
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    app[verb] = (p, ...rest) => routes.set(`${verb.toUpperCase()} ${p}`, rest[rest.length - 1]);
  }
  const noop = () => {};
  const money = createMoney({
    pool: { query: async () => ({ rows: [] }) },
    economics: require('./economics.js'),
    alert,
    supportBar: { add: () => ({ deltaSeconds: 0 }), getTotal: () => 0, reset: noop },
    timer: { snapshot: () => ({ locked: false }), addMoney: noop, adjust: noop, set: noop,
             control: noop, setConfig: noop, config: () => ({}), parseDuration: () => 0 },
    tts: null, sounds: { manifest: () => [] }, cleanForTTS: (s) => s,
    recordSupport: async () => 1, persistEventCard: async () => 1,
    maskBlacklist: (s) => s, broadcast: noop, bufferPush: noop, bufferReplace: noop,
    ALERT_TTS_ENABLED: false,
  });
  money.registerMoneyRoutes(app, { requireInternal: (_q, _s, n) => n && n(), wrap: (fn) => fn });
  const handler = routes.get('POST /alert');
  assert.ok(handler, 'POST /alert is no longer registered');

  return {
    dispatched,
    async post(body) {
      let payload; let status = 200;
      const res = { json: (b) => { payload = b; return res; }, status: (c) => { status = c; return res; } };
      await handler({ body }, res);
      return { status, payload };
    },
  };
}

// ── every real producer payload must still be accepted ──────────────────────

const REAL_PAYLOADS = [
  // stream-ingest/lib/alerts.js — twitch (base: platform, username, userId)
  ['twitch sub',            { platform: 'twitch', eventType: 'sub', username: 'a', userId: '1', tier: '1000', months: 1, message: '', label: 'subscribed' }],
  ['twitch resub',          { platform: 'twitch', eventType: 'resub', username: 'a', userId: '1', tier: '1000', months: 7, message: 'hi', label: 'resubscribed · 7 months' }],
  ['twitch giftsub',        { platform: 'twitch', eventType: 'giftsub', username: 'a', userId: '1', tier: '1000', months: 1, recipient: 'b', label: 'gifted a sub' }],
  ['twitch giftbomb',       { platform: 'twitch', eventType: 'giftbomb', username: 'a', userId: '1', tier: '1000', count: 5, label: 'gifted 5 subs' }],
  ['twitch bits',           { platform: 'twitch', eventType: 'bits', username: 'a', userId: '1', bits: 500, message: 'cheer', label: 'cheered' }],
  ['twitch prime-upgrade',  { platform: 'twitch', eventType: 'prime-upgrade', username: 'a', userId: '1', tier: '1000', label: 'upgraded Prime → Tier 1' }],
  ['twitch pay-it-forward', { platform: 'twitch', eventType: 'pay-it-forward', username: 'a', userId: '1', tier: '1000', recipient: 'b', label: 'paid it forward to b' }],
  // youtube (base: platform, username, userImage)
  ['youtube superchat',     { platform: 'youtube', eventType: 'superchat', username: 'a', userImage: '', amount: 5, currency: 'USD', message: 'yo', label: 'super chat' }],
  ['youtube supersticker',  { platform: 'youtube', eventType: 'supersticker', username: 'a', userImage: '', amount: 2, currency: 'USD', label: 'super sticker' }],
  ['youtube membership',    { platform: 'youtube', eventType: 'membership-new', username: 'a', userImage: '', label: 'became a member' }],
  ['youtube memb-gift',     { platform: 'youtube', eventType: 'membership-gift', username: 'a', userImage: '', count: 3, label: 'gifted 3 memberships' }],
  ['youtube milestone',     { platform: 'youtube', eventType: 'membership-milestone', username: 'a', userImage: '', label: 'member · month 4' }],
  // kick
  ['kick sub',              { platform: 'kick', eventType: 'sub', username: 'a', months: 1, label: 'subscribed' }],
  ['kick giftsub',          { platform: 'kick', eventType: 'giftsub', username: 'a', count: 2, label: 'gifted 2 subs' }],
  ['kick kicks',            { platform: 'kick', eventType: 'kicks', username: 'a', kicks: 100, label: 'sent 100 Kicks' }],
  // tools/simulate-event.js
  ['simulate kofi',         { platform: 'kofi', eventType: 'donation', username: 'a', message: 'm', amount: 5, currency: 'USD', label: 'donated' }],
  ['simulate patreon',      { platform: 'patreon', eventType: 'pledge-create', username: 'a', message: 'm', cents: 500, currency: 'USD', label: 'pledged' }],
  // webhooks.js shapes — routed here too by simulate-event / any future HTTP producer
  ['kofi membership',       { platform: 'kofi', eventType: 'membership', username: 'a', amount: 3, currency: 'USD', message: '', label: 'subscribed on ko-fi · Tier' }],
  ['streamlabs donation',   { platform: 'streamlabs', eventType: 'donation', username: 'a', amount: 10, currency: 'USD', message: 'ty', label: 'donated' }],
];

test('every real producer payload is accepted — no amount field is required', async () => {
  for (const [label, body] of REAL_PAYLOADS) {
    const h = routeHarness();
    const { status } = await h.post(body);
    assert.equal(status, 200,
      `${label} was REJECTED. This payload is what a real producer sends — rejecting it means a ` +
      'live donation or sub silently produces no alert, which is worse than no validation.');
    assert.equal(h.dispatched.length, 1, `${label} was accepted but never dispatched`);
  }
});

test('payloads carrying NO monetary field at all are still accepted', async () => {
  // Subs, gifts, milestones and Prime upgrades carry only months/count/tier — the
  // take-home is derived server-side from the platform tables. A validator that
  // insisted on an amount would drop all of them.
  for (const body of [
    { platform: 'twitch', eventType: 'prime-upgrade', username: 'a' },
    { platform: 'youtube', eventType: 'membership-milestone', username: 'a' },
    { platform: 'kick', eventType: 'sub', username: 'a' },
  ]) {
    const h = routeHarness();
    const { status } = await h.post(body);
    assert.equal(status, 200, `${body.platform}/${body.eventType} needs no amount and must pass`);
  }
});

test('an unknown platform is accepted, not whitelisted away', async () => {
  // A whitelist would 400 the day a platform is added, during that platform's
  // launch. An unknown platform already resolves to take-home 0 safely.
  const h = routeHarness();
  const { status } = await h.post({ platform: 'tiktok', eventType: 'gift', username: 'a', amount: 1 });
  assert.equal(status, 200, 'a new platform must not be rejected by stream-api');
});

// ── what IS rejected ────────────────────────────────────────────────────────

test('a body that cannot describe an event is rejected, not broadcast', async () => {
  // dispatch({}) without this check would emit 3 broadcast frames + a persisted
  // card: a junk alert in live chat and a row in the DB.
  for (const [label, body] of [
    ['empty object', {}],
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ platform: 'twitch', eventType: 'sub' }]],
    ['a string', 'twitch'],
    ['platform only', { platform: 'twitch' }],
    ['eventType only', { eventType: 'sub' }],
    ['blank platform', { platform: '   ', eventType: 'sub' }],
    ['blank eventType', { platform: 'twitch', eventType: '  ' }],
    ['non-string platform', { platform: 123, eventType: 'sub' }],
    ['null eventType', { platform: 'twitch', eventType: null }],
  ]) {
    const h = routeHarness();
    const { status } = await h.post(body);
    assert.equal(status, 400, `${label} was ACCEPTED — this would broadcast a junk alert card`);
    assert.equal(h.dispatched.length, 0, `${label} reached dispatch() despite being invalid`);
  }
});

// ── the money guard (covers the in-process producers too) ───────────────────

function effectsHarness() {
  const frames = [];
  const credited = [];
  const alert = createAlert({
    broadcast: (f) => frames.push(f),
    bufferPush: () => {},
    supportBar: { add: (amt) => { credited.push(amt); return { deltaSeconds: 1 }; }, getTotal: () => 0 },
    obs: null, lights: null, tts: null,
    logSupport: async (row) => { credited.push(`ledger:${row.amountUsd}`); return 1; },
    persistCard: async () => 1,
    maskBlacklist: (s) => s,
    timerLocked: () => false,
  });
  return { alert, frames, credited };
}

test('a negative take-home is clamped to 0 and never rides the WS frame', async () => {
  // Only streamlabsTakeHome() has a Math.max(0, ...) floor; bits/super/kofi/patreon/
  // kicks propagate a negative straight through. Measured: bits=-100000 -> -1000.
  for (const [label, input] of [
    ['twitch bits',   { platform: 'twitch', eventType: 'bits', bits: -100000, username: 'x' }],
    ['kick kicks',    { platform: 'kick', eventType: 'kicks', kicks: -5000, username: 'x' }],
    ['youtube super', { platform: 'youtube', eventType: 'superchat', amount: -50, currency: 'USD', username: 'x' }],
    ['kofi',          { platform: 'kofi', eventType: 'donation', amount: -20, currency: 'USD', username: 'x' }],
    ['patreon',       { platform: 'patreon', eventType: 'pledge-create', cents: -5000, currency: 'USD', username: 'x' }],
    ['direct field',  { platform: 'kofi', eventType: 'donation', takeHomeUSD: -500, username: 'x' }],
  ]) {
    const h = effectsHarness();
    const r = await h.alert.fireStreamEffects(input);
    assert.equal(r.takeHome, 0, `${label}: a negative take-home survived`);
    // There is no money-bearing `alert` WS frame; the clamp is observable through
    // the return + the ledger.
    assert.ok(!h.frames.some((f) => f.type === 'alert'),
      `${label}: the removed alert frame came back`);
    assert.deepEqual(h.credited, [], `${label}: a negative amount reached the ledger or the bar`);
  }
});

test('a non-finite supplied takeHomeUSD becomes 0 — and no longer silently', async () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', {}]) {
    const h = effectsHarness();
    const r = await h.alert.fireStreamEffects(
      { platform: 'kofi', eventType: 'donation', takeHomeUSD: bad, username: 'x' });
    assert.equal(r.takeHome, 0, `takeHomeUSD=${String(bad)} must not produce NaN downstream`);
    assert.ok(!Number.isNaN(r.takeHome), 'NaN would poison the ledger amount and the bar');
    assert.deepEqual(h.credited, [], 'an unusable take-home must not credit anything');
  }
});

test('legitimate take-home is untouched by the guard', async () => {
  // The guard must be invisible in the normal case, including the exact-zero events
  // (milestones, unknown types) that are legitimately worth nothing.
  const h1 = effectsHarness();
  const paid = await h1.alert.fireStreamEffects(
    { platform: 'kofi', eventType: 'donation', amount: 20, currency: 'USD', username: 'x' });
  assert.ok(paid.takeHome > 18 && paid.takeHome <= 20,
    `a $20 ko-fi donation should net ~19; got ${paid.takeHome}`);
  assert.ok(h1.credited.some((c) => String(c).startsWith('ledger:')), 'the ledger was not written');

  const h2 = effectsHarness();
  const direct = await h2.alert.fireStreamEffects(
    { platform: 'kofi', eventType: 'donation', takeHomeUSD: 12.34, username: 'x' });
  assert.equal(direct.takeHome, 12.34, 'a caller-supplied take-home must pass through exactly');

  const h3 = effectsHarness();
  const free = await h3.alert.fireStreamEffects(
    { platform: 'youtube', eventType: 'membership-milestone', username: 'x' });
  assert.equal(free.takeHome, 0, 'a milestone is legitimately worth 0');
  assert.deepEqual(h3.credited, [], 'a 0 take-home must not write a ledger row');
});

test('a very large donation is NOT capped', async () => {
  // A ceiling would silently truncate the single most consequential event this path
  // can carry. Clamping is only ever toward 0, never downward from a valid amount.
  const h = effectsHarness();
  const r = await h.alert.fireStreamEffects(
    { platform: 'kofi', eventType: 'donation', takeHomeUSD: 25000, username: 'whale' });
  assert.equal(r.takeHome, 25000, 'a large but valid take-home must survive intact');
});
