// platform-states.js — the per-platform state snapshot stream-ingest posts every poller tick, and
// what the site may read of it (/stream/current `liveness`, the `platformStates` frame).
//
// Run: node --test platform-states.test.js

'use strict';
const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const { createPlatformStates } = require('./platform-states');
const { PLATFORM_LIVENESS } = require('./platformLiveness.generated.js');
const { publicReplacer } = require('./ws-hub');

const T0 = Date.parse('2026-10-25T20:00:00Z');

// One poller state as stream-ingest sends it: every field the model keeps, most of them private.
const st = (state, extra = {}) => ({
  state, since: T0 - 60_000, lastAnswerAt: T0 - 1000, misses: 0, key: 'bbbb1111', evidence: 'helix-live',
  scheduledStart: null, ...extra,
});

function harness() {
  let t = T0;
  const frames = [];
  const ps = createPlatformStates({ broadcast: (f) => frames.push(f), now: () => t });
  const routes = {};
  ps.registerRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/stream/platforms']({ body }, res);
    return res;
  };
  return { ps, frames, routes, post, at: (ms) => { t = ms; }, now: () => t };
}

// ── publicSnapshot: the one sanitizer (config/platform-liveness.mjs) ──

test('publicSnapshot keeps state, since and (YouTube upcoming only) scheduledStart — nothing else', () => {
  const snap = PLATFORM_LIVENESS.publicSnapshot({
    twitch: st('live'),
    kick: st('offline', { misses: 1, evidence: 'offline-pending' }),
    youtube: st('upcoming', { scheduledStart: T0 + 600_000, key: 'vvvv1111111', evidence: 'upcoming' }),
    streamplace: null,
  }, T0);
  assert.deepEqual(snap, {
    at: T0,
    platforms: {
      twitch: { state: 'live', since: T0 - 60_000 },
      kick: { state: 'offline', since: T0 - 60_000 },
      youtube: { state: 'upcoming', since: T0 - 60_000, scheduledStart: T0 + 600_000 },
    },
  });
});

test('publicSnapshot drops names it does not know, maps a state it does not know to unknown, keeps scheduledStart only for YouTube upcoming', () => {
  const snap = PLATFORM_LIVENESS.publicSnapshot({
    twitch: st('exploded'),
    myspace: st('live'),
    kick: st('upcoming', { scheduledStart: T0 + 1 }),
    youtube: st('live', { scheduledStart: T0 + 1 }),
    __proto__: { streamplace: st('live') },
  }, T0);
  assert.deepEqual(snap.platforms, {
    twitch: { state: 'unknown', since: T0 - 60_000 },
    kick: { state: 'upcoming', since: T0 - 60_000 },
    youtube: { state: 'live', since: T0 - 60_000 },
  });
  for (const junk of [null, undefined, 'live', 42, [st('live')]]) {
    assert.deepEqual(PLATFORM_LIVENESS.publicSnapshot(junk, T0), { at: T0, platforms: {} }, `platforms=${JSON.stringify(junk)}`);
  }
});

test('publicSnapshot is idempotent on its own output', () => {
  const once = PLATFORM_LIVENESS.publicSnapshot({
    twitch: st('live'), kick: st('nope'), youtube: st('upcoming', { scheduledStart: T0 + 5 }), streamplace: st('offline'),
  }, T0);
  const twice = PLATFORM_LIVENESS.publicSnapshot(once.platforms, T0);
  assert.deepEqual(twice.platforms, once.platforms);
});

// ── the relay ──

test('sanitized: no evidence, key or misses anywhere in the snapshot, the frame or the route answer', async () => {
  const h = harness();
  const res = await h.post({ at: T0, nextInMs: 60_000, platforms: {
    twitch: st('live'), kick: st('offline', { misses: 1 }), youtube: st('upcoming', { scheduledStart: T0 + 9 }), streamplace: st('unknown'),
  } });
  assert.deepEqual(res.body, { ok: true });
  for (const [what, v] of [['snapshot', h.ps.snapshot()], ['frame', h.ps.frame()], ['broadcast', h.frames[0]]]) {
    const json = JSON.stringify(v);
    for (const banned of ['evidence', 'key', 'misses', 'lastAnswerAt', 'bbbb1111', 'helix-live']) {
      assert.ok(!json.includes(banned), `${what} carries ${banned}: ${json}`);
    }
  }
  assert.equal(h.ps.snapshot().at, T0, 'at is stream-api\'s receive time');
});

test('a non-object body answers 400 and changes nothing', async () => {
  const h = harness();
  await h.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live') } });
  for (const bad of [null, 'live', 7, [], { at: T0, platforms: 'live' }, { at: T0, platforms: null }]) {
    const res = await h.post(bad);
    assert.equal(res.statusCode, 400, `body=${JSON.stringify(bad)}`);
  }
  assert.equal(h.ps.snapshot().platforms.twitch.state, 'live');
  assert.equal(h.frames.length, 1);
});

test('unchanged → no broadcast; changed → exactly one', async () => {
  const h = harness();
  await h.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live'), kick: st('offline') } });
  assert.equal(h.frames.length, 1, 'the first report is a change');
  h.at(T0 + 60_000);
  // A new tick with the same public picture (only private fields moved) is not news.
  await h.post({ at: T0 + 60_000, nextInMs: 60_000, platforms: { twitch: st('live', { lastAnswerAt: T0 + 59_000 }), kick: st('offline', { misses: 2 }) } });
  assert.equal(h.frames.length, 1, 'an unchanged picture broadcast again');
  h.at(T0 + 120_000);
  await h.post({ at: T0 + 120_000, nextInMs: 60_000, platforms: { twitch: st('live'), kick: st('live', { since: T0 + 119_000 }) } });
  assert.equal(h.frames.length, 2);
  assert.deepEqual(h.frames[1], { type: 'platformStates', at: T0 + 120_000, platforms: {
    twitch: { state: 'live', since: T0 - 60_000 }, kick: { state: 'live', since: T0 + 119_000 },
  } });
});

test('the last body received wins — an ingest restart (older `at`, no sequence) is not ignored', async () => {
  const h = harness();
  await h.post({ at: T0 + 500_000, nextInMs: 60_000, platforms: { twitch: st('live') } });
  h.at(T0 + 10_000);
  await h.post({ at: T0, nextInMs: 180_000, platforms: { twitch: st('offline') } });
  assert.equal(h.ps.snapshot().platforms.twitch.state, 'offline');
});

test('never reported → platforms {} (the site keeps what it shows; nothing is invented)', () => {
  const h = harness();
  assert.deepEqual(h.ps.snapshot().platforms, {});
  assert.deepEqual(h.ps.frame(), { type: 'platformStates', at: T0, platforms: {} });
});

test('frame() passes through ws-hub\'s publicReplacer unchanged (nothing internal rides it)', async () => {
  const h = harness();
  await h.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live'), youtube: st('upcoming', { scheduledStart: T0 + 3 }) } });
  const f = h.ps.frame();
  assert.deepEqual(JSON.parse(JSON.stringify(f, publicReplacer)), f);
});

// Review Focus 1: stream-ingest stops (or stream-api lost it) mid-stream → every platform reads
// `unknown`, broadcast ONCE; the night does not end on this signal (nothing here touches a session).
test('silence: no report for clamp(3 × nextInMs, 180 s, 600 s) → every platform present reads unknown, one broadcast', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const h = harness();
  await h.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live'), kick: st('offline'), youtube: st('upcoming', { scheduledStart: T0 + 7 }) } });
  assert.equal(h.frames.length, 1);
  // 3 × 60 s = 180 s: still fresh one ms before it.
  h.at(T0 + 179_999);
  mock.timers.tick(30_000);
  assert.equal(h.ps.snapshot().platforms.twitch.state, 'live');
  assert.equal(h.frames.length, 1, 'a fresh snapshot broadcast on the timer');
  h.at(T0 + 180_000);
  assert.deepEqual(h.ps.snapshot().platforms, {
    twitch: { state: 'unknown', since: T0 + 180_000 },
    kick: { state: 'unknown', since: T0 + 180_000 },
    youtube: { state: 'unknown', since: T0 + 180_000 },
  }, 'silent: every platform present reads unknown, from when the silence began');
  mock.timers.tick(30_000);
  assert.equal(h.frames.length, 2, 'the silence flip is broadcast');
  assert.equal(h.frames[1].platforms.twitch.state, 'unknown');
  h.at(T0 + 400_000);
  mock.timers.tick(30_000);
  mock.timers.tick(30_000);
  assert.equal(h.frames.length, 2, 'silence is broadcast once, not every 30 s');
  // A report again (an ingest restart) ends the silence at once.
  h.at(T0 + 401_000);
  await h.post({ at: T0 + 401_000, nextInMs: 180_000, platforms: { twitch: st('live') } });
  assert.equal(h.frames.length, 3);
  assert.deepEqual(h.frames[2].platforms, { twitch: { state: 'live', since: T0 - 60_000 } });
  h.ps.stop();
});

// A page holds the newest snapshot by `at` (web livePlatforms.ts `newest`, a tie keeps what is
// shown): a silence snapshot carrying the last report's `at` was dropped by every open page, which
// kept hiding a source (or saying "The stream has ended.") through the whole outage.
test('silence: the silent snapshot is stamped when the silence began — newer than the last report, so an open page applies it', async (t) => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const h = harness();
  await h.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live'), youtube: st('offline') } });
  assert.equal(h.ps.snapshot().at, T0);
  h.at(T0 + 181_000);
  const silent = h.ps.snapshot();
  assert.equal(silent.platforms.youtube.state, 'unknown');
  assert.ok(silent.at > T0, `the silent snapshot's at (${silent.at}) is newer than the report's (${T0})`);
  assert.equal(silent.at, T0 + 180_000, 'the moment the silence began, the same as every platform\'s since');
  mock.timers.tick(30_000);
  assert.equal(h.frames.length, 2);
  assert.equal(h.frames[1].at, T0 + 180_000, 'the broadcast silence frame carries it too');
  h.ps.stop();
});

test('silence window: 3 × nextInMs, never under 180 s nor over 600 s; a missing nextInMs is the floor', async () => {
  for (const [nextInMs, silentAfter] of [[180_000, 540_000], [10_000, 180_000], [3_600_000, 600_000], [undefined, 180_000], ['soon', 180_000], [-5, 180_000]]) {
    const h = harness();
    await h.post({ at: T0, nextInMs, platforms: { twitch: st('live') } });
    h.at(T0 + silentAfter - 1);
    assert.equal(h.ps.snapshot().platforms.twitch.state, 'live', `nextInMs=${nextInMs}: live 1 ms before ${silentAfter}`);
    h.at(T0 + silentAfter);
    assert.equal(h.ps.snapshot().platforms.twitch.state, 'unknown', `nextInMs=${nextInMs}: unknown at ${silentAfter}`);
    h.ps.stop();
  }
});

// Restart: a fresh stream-api knows nothing until the next tick — it reads {} (missing = keep, on
// the site), never a stale picture and never a silence of platforms it has not heard of.
test('restart: a new relay starts empty and the first report after it is broadcast', async () => {
  const before = harness();
  await before.post({ at: T0, nextInMs: 60_000, platforms: { twitch: st('live') } });
  before.ps.stop();
  const after = harness();
  assert.deepEqual(after.ps.snapshot().platforms, {});
  await after.post({ at: T0 + 60_000, nextInMs: 60_000, platforms: { twitch: st('live') } });
  assert.equal(after.frames.length, 1);
  after.ps.stop();
});

// Retry: the poller re-posts the same full snapshot on its next tick after a failed POST. The
// repeat is idempotent: same answer, no second frame.
test('retry: the same body twice answers ok both times and broadcasts once', async () => {
  const h = harness();
  const body = { at: T0, nextInMs: 60_000, platforms: { twitch: st('live'), kick: st('offline') } };
  assert.deepEqual((await h.post(body)).body, { ok: true });
  assert.deepEqual((await h.post(body)).body, { ok: true });
  assert.equal(h.frames.length, 1);
  h.ps.stop();
});

test('the interval does not hold the process open, and stop() clears it', () => {
  const h = harness();
  // node --test would hang here for good if the 30 s timer were ref'd and never stopped; stop() is
  // still called, as index.js's shutdown does.
  h.ps.stop();
  h.ps.stop();
});
