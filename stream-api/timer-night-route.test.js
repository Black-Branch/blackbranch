// POST /timer/night (money.js) — Fund the Night's wire surface.
//
// timer.js's startNight/extendNight/endNight own the lifecycle and the
// money→time math (timer.test.js's night section pins that). This file is
// only the route: does it call the right timer method with the right shape,
// does it thread meter.requiredCentsPerDay() and the zone (site.timeZone, else TIMER_TZ) through, does a
// NightConfigError (by `.code`, not by class — timer.js deliberately does not
// export it) become a 400 while anything else escapes to `wrap`'s 500, and is
// requireInternal actually wired.
//
// Harness matches money-durability.test.js / money-policy.test.js: a fake app
// captures the registered handler, deps are plain mocks (not the real timer
// factory — the real lifecycle is timer.test.js's job).
//
// Run: node --test timer-night-route.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney } = require('./money.js');

function harness({ timerOverrides = {}, meterOverrides = {} } = {}) {
  const calls = [];
  const log = (fn, x) => { calls.push({ fn, ...x }); };
  const timer = {
    reset() { log('timer.reset', {}); }, adjust() { return 0; }, set() { return 0; }, control() { return true; },
    snapshot() { return { type: 'timerState', night: { active: false } }; },
    setConfig() { return { usdPerHour: 0, fillUsd: 0 }; },
    startNight(opts) { log('startNight', { opts }); return { type: 'timerState', night: { active: true } }; },
    extendNight(hours) { log('extendNight', { hours }); return { type: 'timerState', night: { active: true } }; },
    endNight() { log('endNight', {}); return { type: 'timerState', night: { active: false } }; },
    ...timerOverrides,
  };
  const meter = {
    requiredCentsPerDay() { return 27000; },
    ...meterOverrides,
  };
  // The sponsor pool is night-scoped state (sponsors.js): a new night, or a
  // stream reset, must rebuild it from the ledger rather than carry last
  // night's donors forward at full weight with re-lit badges.
  let sponsorsThrows = false;
  const sponsors = {
    reset() {
      log('sponsors.reset', {});
      return sponsorsThrows
        ? Promise.reject(new Error('pool rebuild blew up'))
        : Promise.resolve();
    },
  };
  const money = createMoney({
    pool: { query: async () => ({ rows: [{}], rowCount: 1 }) },
    economics: { stripeNet: (usd) => usd, formatUSD: (u) => `$${u.toFixed(2)}` },
    alert: { buildEventCard: () => ({}), fireStreamEffects: async () => ({}), dispatch: async () => {} },
    supportBar: { add: () => ({ deltaSeconds: 0 }), reset: () => { log('supportBar.reset', {}); } },
    timer, meter, sponsors,
    tts: { speak: () => {} },
    sounds: { play: async () => true, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    recordSupport: async () => 'canon',
    persistEventCard: async () => 999,
    maskBlacklist: (t) => t,
    broadcast: () => {}, bufferPush: () => {}, bufferReplace: () => {},
    ttsEnabled: () => false,
  });
  const routes = {};
  let nightAuthCount = null;
  money.registerMoneyRoutes(
    {
      post: (p, ...h) => {
        if (p === '/timer/night') nightAuthCount = h.length;
        routes[p] = h[h.length - 1];
      },
      get: (p, ...h) => { routes[p] = h[h.length - 1]; },
    },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  assert.ok(routes['/timer/night'], 'POST /timer/night did not register');
  const postTo = async (path, body) => {
    assert.ok(routes[path], `POST ${path} did not register`);
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await routes[path]({ body }, res);
    return res;
  };
  const post = (body) => postTo('/timer/night', body);
  return {
    calls, post, postTo, nightAuthCount,
    sponsorsFail: () => { sponsorsThrows = true; },
  };
}

// ── requireInternal ──────────────────────────────────────────────────────────

test('/timer/night is registered WITH auth middleware', () => {
  const h = harness();
  assert.ok(h.nightAuthCount > 1, '/timer/night registered WITHOUT requireInternal');
});

// ── start ────────────────────────────────────────────────────────────────────

test('start: 200 + the night snapshot from timer.startNight', async () => {
  const h = harness();
  const res = await h.post({ action: 'start', end: '4am' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'timerState');
  assert.equal(res.body.night.active, true);
});

test('start: passes endLocal/seedSec/priceCents through, and folds in the meter\'s required$/day', async () => {
  const h = harness();
  await h.post({ action: 'start', end: '4am', seedSec: 3600, priceCents: 500 });
  const call = h.calls.find((c) => c.fn === 'startNight');
  assert.ok(call, 'timer.startNight was not called');
  assert.equal(call.opts.endLocal, '4am');
  assert.equal(call.opts.seedSec, 3600);
  assert.equal(call.opts.priceCents, 500);
  assert.equal(call.opts.requiredCentsPerDay, 27000);
});

test('start: a null meter snapshot (no read yet) becomes requiredCentsPerDay 0, not null', async () => {
  // startNight's own default param only fires on `undefined` — a bare `null`
  // would sail past it and hit night-math with a non-number.
  const h = harness({ meterOverrides: { requiredCentsPerDay() { return null; } } });
  await h.post({ action: 'start', end: '4am' });
  const call = h.calls.find((c) => c.fn === 'startNight');
  assert.equal(call.opts.requiredCentsPerDay, 0);
});

test('start: TIMER_TZ threads through as tz; unset stays undefined (startNight\'s system-zone default)', async () => {
  const prior = process.env.TIMER_TZ;
  try {
    delete process.env.TIMER_TZ;
    const h1 = harness();
    await h1.post({ action: 'start', end: '4am' });
    assert.equal(h1.calls.find((c) => c.fn === 'startNight').opts.tz, undefined);

    process.env.TIMER_TZ = 'America/Denver';
    const h2 = harness();
    await h2.post({ action: 'start', end: '4am' });
    assert.equal(h2.calls.find((c) => c.fn === 'startNight').opts.tz, 'America/Denver');
  } finally {
    if (prior === undefined) delete process.env.TIMER_TZ; else process.env.TIMER_TZ = prior;
  }
});

test('start: the install\'s time zone (site.timeZone) is the night\'s zone, ahead of TIMER_TZ — read per start, no restart', async () => {
  // The bundle passes no TIMER_TZ, so without site.timeZone every install would read "4am" in UTC
  // while the wizard's time zone sat unused. site.timeZone resolves env SITE_TIME_ZONE > stored value > default; the
  // env form is how this test sets it on the settings singleton.
  const prior = { tz: process.env.TIMER_TZ, site: process.env.SITE_TIME_ZONE };
  try {
    process.env.TIMER_TZ = 'America/Denver';
    process.env.SITE_TIME_ZONE = 'Pacific/Auckland';
    const h = harness();
    await h.post({ action: 'start', end: '4am' });
    assert.equal(h.calls.find((c) => c.fn === 'startNight').opts.tz, 'Pacific/Auckland');

    // Same harness, the setting changed: the next start reads it (retry path, no new process).
    process.env.SITE_TIME_ZONE = 'Europe/Berlin';
    await h.post({ action: 'start', end: '4am', force: true });
    assert.equal(h.calls.filter((c) => c.fn === 'startNight').at(-1).opts.tz, 'Europe/Berlin');
  } finally {
    if (prior.tz === undefined) delete process.env.TIMER_TZ; else process.env.TIMER_TZ = prior.tz;
    if (prior.site === undefined) delete process.env.SITE_TIME_ZONE; else process.env.SITE_TIME_ZONE = prior.site;
  }
});

test('start: a garbage end time → 400 with NightConfigError\'s message, not a 500', async () => {
  const h = harness({
    timerOverrides: {
      startNight() {
        const e = new Error('startNight: could not parse endLocal "garbage"');
        e.code = 'INVALID_END_LOCAL';
        throw e;
      },
    },
  });
  const res = await h.post({ action: 'start', end: 'garbage' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /could not parse endLocal/);
});

test('start: an unknown timezone (INVALID_TZ) → 400', async () => {
  const h = harness({
    timerOverrides: {
      startNight() {
        const e = new Error('startNight: unknown timezone "Nowhere/Fake"');
        e.code = 'INVALID_TZ';
        throw e;
      },
    },
  });
  const res = await h.post({ action: 'start', end: '4am' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /unknown timezone/);
});

test('start: any OTHER throw is NOT swallowed as a 400 — it escapes to wrap (500 path)', async () => {
  const h = harness({
    timerOverrides: {
      startNight() { throw new Error('boom — unrelated failure'); },
    },
  });
  await assert.rejects(() => h.post({ action: 'start', end: '4am' }), /boom — unrelated failure/);
});

// ── extend ───────────────────────────────────────────────────────────────────

test('extend: hours:1 → 200, timer.extendNight(1) called', async () => {
  const h = harness();
  const res = await h.post({ action: 'extend', hours: 1 });
  assert.equal(res.statusCode, 200);
  const call = h.calls.find((c) => c.fn === 'extendNight');
  assert.ok(call);
  assert.equal(call.hours, 1);
});

test('extend: hours:0 → 400, timer.extendNight NOT called', async () => {
  const h = harness();
  const res = await h.post({ action: 'extend', hours: 0 });
  assert.equal(res.statusCode, 400);
  assert.ok(!h.calls.some((c) => c.fn === 'extendNight'));
});

test('extend: hours absent → 400', async () => {
  const h = harness();
  const res = await h.post({ action: 'extend' });
  assert.equal(res.statusCode, 400);
  assert.ok(!h.calls.some((c) => c.fn === 'extendNight'));
});

test('extend: NO_BLOCKS (nothing to extend from) → 400', async () => {
  const h = harness({
    timerOverrides: {
      extendNight() {
        const e = new Error('extendNight: this night has no priced blocks to extend from');
        e.code = 'NO_BLOCKS';
        throw e;
      },
    },
  });
  const res = await h.post({ action: 'extend', hours: 2 });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /no priced blocks/);
});

// ── end ──────────────────────────────────────────────────────────────────────

test('end: 200, timer.endNight() called', async () => {
  const h = harness();
  const res = await h.post({ action: 'end' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.night.active, false);
  assert.ok(h.calls.some((c) => c.fn === 'endNight'));
});

// ── target ───────────────────────

test('target: 200, timer.repriceNight(priceCents) called with the cents as sent', async () => {
  const h = harness({ timerOverrides: {
    repriceNight(priceCents) { h.calls.push({ fn: 'repriceNight', priceCents }); return { type: 'timerState', night: { active: true } }; },
  } });
  const res = await h.post({ action: 'target', priceCents: 30000 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.night.active, true);
  const call = h.calls.find((c) => c.fn === 'repriceNight');
  assert.ok(call, 'repriceNight was not called');
  assert.equal(call.priceCents, 30000, 'the cents must pass through untranslated');
});

test('target: a NightConfigError from repriceNight (no night / bad amount) is a 400 with its sentence', async () => {
  const h = harness({ timerOverrides: {
    repriceNight() {
      const e = new Error('repriceNight: no night is running — the target prices a night, start one first');
      e.code = 'NO_NIGHT';
      throw e;
    },
  } });
  const res = await h.post({ action: 'target', priceCents: 30000 });
  assert.equal(res.statusCode, 400, 'NO_NIGHT must translate to a caller error, not a 500');
  assert.match(res.body.error, /no night is running/);
});

// ── unknown action ───────────────────────────────────────────────────────────

test('unknown action → 400, nothing on timer called', async () => {
  const h = harness();
  const res = await h.post({ action: 'bogus' });
  assert.equal(res.statusCode, 400);
  assert.equal(h.calls.length, 0);
});

test('missing body → 400, not a throw', async () => {
  const h = harness();
  const res = await h.post(undefined);
  assert.equal(res.statusCode, 400);
});

// ── The sponsor pool's night lifecycle ──────────────────────────────────────
//
// sponsors.js keeps a live, in-memory pool keyed to ONE night: weights ranked
// against tonight's cohort, badge clocks denominated in `night.elapsedSec`.
// `startNight` resets that elapsed to 0, so a night opened while the previous
// night's pool is still loaded ranks yesterday's donors as tonight's and
// re-lights every one of their badges from the top. The pool is rebuilt from
// the ledger instead — which is also where the 0.25x previous-session weight
// and the no-badges rule for it live.

test('start: the sponsor pool is rebuilt for the new night', async () => {
  const h = harness();
  await h.post({ action: 'start', end: '4am' });
  assert.ok(h.calls.some((c) => c.fn === 'sponsors.reset'),
    'a new night opened on top of the previous night\'s pool — full-weight donors, resurrected badges');
});

test('start: the pool is rebuilt AFTER the night is opened, never before', async () => {
  // Order matters: the replay reads the night's own structure, so a rebuild
  // that ran first would rebuild against the night that just ended.
  const h = harness();
  await h.post({ action: 'start', end: '4am' });
  const startAt = h.calls.findIndex((c) => c.fn === 'startNight');
  const resetAt = h.calls.findIndex((c) => c.fn === 'sponsors.reset');
  assert.ok(startAt !== -1 && resetAt !== -1, 'premise: both calls fired');
  assert.ok(startAt < resetAt, 'the pool was rebuilt before the night existed');
});

test('extend and end do NOT rebuild the pool — the same night\'s donors keep their live rows', async () => {
  const h = harness();
  await h.post({ action: 'extend', hours: 1 });
  await h.post({ action: 'end' });
  assert.ok(!h.calls.some((c) => c.fn === 'sponsors.reset'),
    'an encore or an ending is the SAME night — rebuilding would drop live-keyed rows for no reason');
});

test('a failing sponsors.reset() must not fail the night', async () => {
  // The pool is gratitude, not money. A rebuild that throws (DB blip mid-start)
  // degrades to a stale pool; it must never turn a night start into a 500.
  const h = harness();
  h.sponsorsFail();
  const res = await h.post({ action: 'start', end: '4am' });
  assert.equal(res.statusCode, 200);
});

test('/support-bar/reset clears the sponsor pool alongside the bar and the timer', async () => {
  const h = harness();
  const res = await h.postTo('/support-bar/reset', {});
  assert.equal(res.statusCode, 200);
  assert.ok(h.calls.some((c) => c.fn === 'supportBar.reset'), 'premise: the bar reset still fires');
  assert.ok(h.calls.some((c) => c.fn === 'sponsors.reset'),
    'a fresh stream kept the previous stream\'s sponsors on the credit line');
});

// ── /timer/adjust: a refusal says WHY ────────────────────────────────────────
// A refused adjust is `{ ok: false, seconds: 0 }` — a 200, not an error — and
// it names the reason in a sentence, from the timer's own state. "Locked at
// zero" is false during a night (`lockAtZero` does not apply): a night's
// refusals are the seed floor (only SOLD time can be subtracted — `nightFloor`)
// and the funded ceiling. ONE writer of the sentence, which the panel and the
// /timer slash command both show verbatim.

function adjustHarness({ nightActive, applied = 0 }) {
  return harness({
    timerOverrides: {
      adjust() { return applied; },
      snapshot() { return { type: 'timerState', night: { active: nightActive } }; },
    },
  });
}

test('/timer/adjust: a refused SUBTRACT during a night names the seed floor', async () => {
  const h = adjustHarness({ nightActive: true });
  const res = await h.postTo('/timer/adjust', { input: '30m', sign: -1 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.seconds, 0);
  assert.match(res.body.reason, /only sold time/i);
  assert.doesNotMatch(res.body.reason, /locked at zero/i, 'a night has no zero lock');
});

test('/timer/adjust: a refused ADD during a night points at the encore', async () => {
  const h = adjustHarness({ nightActive: true });
  const res = await h.postTo('/timer/adjust', { input: '30m', sign: 1 });
  assert.equal(res.body.ok, false);
  assert.match(res.body.reason, /funded to its end/i);
  assert.match(res.body.reason, /extend/i);
});

test('/timer/adjust: with no night, a refused add is the lock/cap and a refused sub is "at zero"', async () => {
  const add = await adjustHarness({ nightActive: false }).postTo('/timer/adjust', { input: '30m', sign: 1 });
  assert.match(add.body.reason, /locked at zero|at its cap/i);
  const sub = await adjustHarness({ nightActive: false }).postTo('/timer/adjust', { input: '30m', sign: -1 });
  assert.match(sub.body.reason, /already at zero/i);
});

test('/timer/adjust: an unparseable duration says so, not a lock story', async () => {
  const res = await adjustHarness({ nightActive: true }).postTo('/timer/adjust', { input: 'banana', sign: 1 });
  assert.equal(res.body.ok, false);
  assert.match(res.body.reason, /duration/i);
});

test('/timer/adjust: an APPLIED adjust carries no reason', async () => {
  const res = await adjustHarness({ nightActive: true, applied: 1800 }).postTo('/timer/adjust', { input: '30m', sign: 1 });
  assert.deepEqual(res.body, { ok: true, seconds: 1800 });
});

// ── Two buttons that must not destroy a running night silently ──────────────

test('F-2: "Start night" over a night that is already running is REFUSED with a sentence — unless forced', async () => {
  const h = harness({ timerOverrides: { snapshot() { return { type: 'timerState', night: { active: true } }; } } });
  const res = await h.post({ action: 'start', end: '4am' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already running/i);
  assert.match(res.body.error, /end it first/i);
  assert.equal(h.calls.filter((c) => c.fn === 'startNight').length, 0, 'the running night must be untouched');
  assert.equal(h.calls.filter((c) => c.fn === 'sponsors.reset').length, 0, 'and its credit line too');

  const forced = await h.post({ action: 'start', end: '4am', force: true });
  assert.equal(forced.statusCode, 200);
  assert.equal(h.calls.filter((c) => c.fn === 'startNight').length, 1, 'force:true replaces it deliberately');
});

test('F-2: with no night running, start is unchanged', async () => {
  const h = harness();
  const res = await h.post({ action: 'start', end: '4am' });
  assert.equal(res.statusCode, 200);
  assert.equal(h.calls.filter((c) => c.fn === 'startNight').length, 1);
});

test('F-1: "Reset" (a fresh stream) during a night is REFUSED — it would hand out unsold frontier and freeze the clock', async () => {
  const h = harness({ timerOverrides: { snapshot() { return { type: 'timerState', night: { active: true } }; } } });
  const res = await h.postTo('/support-bar/reset', {});
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /night is running/i);
  assert.equal(h.calls.filter((c) => c.fn === 'supportBar.reset').length, 0, 'the bar must not be zeroed either');
  assert.equal(h.calls.filter((c) => c.fn === 'timer.reset').length, 0);
  assert.equal(h.calls.filter((c) => c.fn === 'sponsors.reset').length, 0);
});

test('F-1: with no night, reset does all three as before', async () => {
  const h = harness();
  const res = await h.postTo('/support-bar/reset', {});
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls.map((c) => c.fn), ['supportBar.reset', 'timer.reset', 'sponsors.reset']);
});
