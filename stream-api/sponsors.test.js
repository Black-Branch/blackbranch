// Tests for sponsors.js — the Fund-the-Night sponsor credit pool + clock
// badges. No network/DB: `pool` is a
// tiny fixture-driven fake that inspects the SQL text, same spirit as the
// fakes in meter.test.js and timer.test.js.
//
// Run: node --test sponsors.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSponsors } = require('./sponsors');
const { NATIVE_PLATFORM, isNativePlatform } = require('./native-platform');
const { layoutBlocks, convertCents } = require('./night-math');
const { createTimer } = require('./timer'); // used for a couple of exact-parity cross-checks against the LIVE path

// ── fixtures ─────────────────────────────────────────────────────────────────

// A canonical's pool entry, whichever key form it sits under: `u:<id>` (a donor who shows their
// links: one row under the site name) or `u:<id>|<name>` (everyone else: one row per donation
// name). `poolIds` lists the keys by identity — canonical id, or the `n:` name key.
function entryOf(state, id) {
  const hits = [...state].filter(([k]) => k === `u:${id}` || k.startsWith(`u:${id}|`));
  assert.ok(hits.length <= 1, `${id} sits under ${hits.length} keys: ${hits.map(([k]) => k).join(', ')}`);
  return hits[0] ? hits[0][1] : undefined;
}
function poolIds(state) { return [...state.keys()].map((k) => k.replace(/\|.*$/, '')); }

// `siteNames`: canonical id -> site.users.display_name for the linked-account
// lookup (sponsors.js resolveDisplayNames). Ids absent from it have no site
// account and keep their donation name. `siteLookup: 'throw'` fails the query.
// `siteNames` are accounts that SHOW their links (site.users.show_links, v153); `hiddenSites` are
// accounts that have not opted in — the real query's `u.show_links` filter leaves them out, and
// this fake does the same only when the SQL carries that filter.
function fakePool({ timerRow = null, sessions = [], events = {}, siteNames = {}, hiddenSites = {}, siteLookup = 'ok', seen = [] } = {}) {
  return {
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (/site\.platform_links/.test(sql)) {
        if (siteLookup === 'throw') throw new Error('site lookup exploded');
        const ids = params[0] || [];
        const all = { ...(/u\.show_links/.test(sql) ? {} : hiddenSites), ...siteNames };
        return { rows: ids.filter((id) => all[id]).map((id) => ({ canonical_id: id, display_name: all[id] })) };
      }
      if (/stream\.timer_state/.test(sql)) {
        return { rows: timerRow ? [timerRow] : [] };
      }
      // Every fold carries the spend-kind exclusion as its LAST parameter; a fixture row with no event_type is a funding row.
      // This models the INTENT, not Postgres's real three-valued logic: JS's
      // `undefined` is simply never IN a list of strings, so this predicate
      // can never distinguish a bare `event_type <> ALL(...)` from the
      // NULL-tolerant `COALESCE(event_type, '') <> ALL(...)` — both read as
      // "funding" here. The dedicated NULL test below pins the real rule as
      // SQL text, which is the only place it can be caught.
      //
      // The exclusion is also platform-scoped: `platform` is NOT NULL in
      // schema.sql (no three-valued-logic trap like event_type's), so this
      // mirror is trustworthy — a fixture row with no `platform` defaults to
      // the site's own platform (every existing fixture row IS one), and only an EXPLICIT
      // other platform escapes the exclusion, same as the real SQL's
      // `platform IN (…native ids…) AND …`.
      const excluded = Array.isArray(params[params.length - 1]) ? params[params.length - 1] : [];
      const funding = (e) => !(isNativePlatform(e.platform ?? NATIVE_PLATFORM) && excluded.includes(e.event_type));
      if (/stream\.sessions/.test(sql)) {
        // Both session queries carry the EXISTS(support_events …) clause with
        // the exclusion INSIDE it — a session whose only rows are spends is
        // not a supported session. The one-param form is latestSupportedSessionId().
        // COALESCE, not a bare `e.event_type <> ALL(...)` — a NULL event_type
        // (money.js stores a blank kind as NULL) must still count as funding;
        // `NULL <> ALL(...)` is NULL and WHERE/EXISTS silently drops it.
        // Platform-scoped too: the site-platform test must be present, or
        // an external platform's donation that happens to share an event_type
        // string with a coin kind (stream-ingest already emits `bits`/'cheered')
        // would be wrongly excluded.
        assert.match(sql, /EXISTS \(SELECT 1 FROM stream\.support_events e\s+WHERE e\.stream_id = s\.stream_id\s+AND NOT \(e\.platform IN \('native'[^)]*\) AND COALESCE\(e\.event_type, ''\) = ANY\(\$\d::text\[\]\)\)\)/,
          'session queries must skip sessions with no FUNDING rows, NULL-tolerantly and platform-scoped to the site');
        const supported = (s) => (events[s.stream_id] || []).some(funding);
        let candidates;
        if (params.length === 1) {
          candidates = sessions.filter((s) => s.ended_at && supported(s));
        } else {
          const current = sessions.find((s) => s.stream_id === params[0]);
          if (!current) return { rows: [] };
          candidates = sessions
            .filter((s) => s.ended_at && supported(s) && s.started_at.getTime() < current.started_at.getTime());
        }
        candidates.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
        return { rows: candidates.length ? [{ stream_id: candidates[0].stream_id }] : [] };
      }
      if (/stream\.support_events/.test(sql)) {
        assert.match(sql, /NOT \((?:e\.)?platform IN \('native'[^)]*\) AND COALESCE\((?:e\.)?event_type, ''\) = ANY\(\$2::text\[\]\)\)/,
          'the replay must exclude spend kinds IN SQL, NULL-tolerantly and platform-scoped to the site');
        const streamId = params[0];
        const rows = (events[streamId] || []).filter(funding).slice().sort((a, b) => a.created_at - b.created_at);
        return { rows };
      }
      throw new Error(`fakePool: unexpected query: ${sql}`);
    },
  };
}

function fakeTimer({ active, elapsedSec, usdPerHour = 0 } = {}) {
  return { snapshot: () => ({ night: { active, elapsedSec }, usdPerHour }) };
}

const noNightRow = {
  night_active: false, night_duration_sec: 0, night_elapsed_sec: 0, night_seed_sec: 0,
  night_price_cents: 0, night_blocks: null, night_started_at: null,
};

// ── live ingest ──────────────────────────────────────────────────────────────

test('ingest: a single contribution appears at 100% with its notional as the badge', () => {
  const frames = [];
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sponsors = createSponsors({ pool: null, broadcast: (f) => frames.push(f), timer, getStreamId: async () => null });

  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 60 });

  const frame = frames[frames.length - 1];
  assert.equal(frame.type, 'sponsorState');
  assert.equal(frame.sponsors.length, 1);
  assert.equal(frame.sponsors[0].name, 'Alice');
  assert.equal(frame.sponsors[0].weightPct, 100);
  // clockUntilElapsed = max(0, 100) + 60 = 160; remain = 160 - 100 = 60
  assert.equal(frame.sponsors[0].clockRemainSec, 60);
});

test('ingest: additive stacking — a second donation from the same identity EXTENDS the badge, does not restart it', () => {
  let elapsed = 100;
  const timer = fakeTimer({ active: true, elapsedSec: elapsed });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });

  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 60 }); // clockUntilElapsed = 160

  elapsed = 120; // 20s of night-elapsed time later, badge still running (160 > 120)
  timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } });
  sponsors.ingest({ username: 'Alice', cents: 500, notionalSec: 30 });
  // max(160, 120) + 30 = 190
  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors.length, 1, 'same identity, one row — not two');
  assert.equal(frame.sponsors[0].clockRemainSec, 70); // 190 - 120
  assert.equal(frame.sponsors[0].weightPct, 100);
});

test('frame: one row per NAME — several identity keys behind one display name merge (GadgetFan ×3)', () => {
  // Replay keys on canonical user_id; the 08-22 stream carried one Streamlabs
  // donor under three ids, so the credit line cycled the same name three
  // times. The identity keys stay distinct in the pool; the WIRE merges.
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  const state = sponsors.__test.state;
  state.set('u:id1', { name: 'GadgetFan', weightSec: 300, clockUntilElapsed: 160, clockStartElapsed: 100 }); // live window [100,160]
  state.set('u:id2', { name: 'gadgetfan', weightSec: 100, clockUntilElapsed: 190, clockStartElapsed: 130 }); // live window [130,190]
  state.set('u:id3', { name: 'GadgetFan', weightSec: 50,  clockUntilElapsed: 90,  clockStartElapsed: 40 });  // expired
  state.set('u:other', { name: 'Dana', weightSec: 50, clockUntilElapsed: 0, clockStartElapsed: 0 });
  const frame = sponsors.__test.buildFrame();
  assert.deepEqual(frame.sponsors.map((s) => s.name), ['GadgetFan', 'Dana'], 'three ids, ONE credit');
  const eddy = frame.sponsors[0];
  assert.equal(eddy.weightPct, 90, 'weight sums across the ids: 450 of 500');
  assert.equal(eddy.clockRemainSec, 90, 'union window ends at the latest end (190 - 100)');
  assert.equal(eddy.clockTotalSec, 90, 'and starts at the earliest RUNNING start (100), not the expired one (40)');
  assert.equal(state.size, 4, 'the pool itself is untouched — identity keys stay separate');
});

test('frame: clockTotalSec is the CURRENT badge window — stacking extends it, a post-expiry mint restarts it', () => {
  let elapsed = 100;
  const timer = fakeTimer({ active: true, elapsedSec: elapsed });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  const frame = () => sponsors.__test.buildFrame().sponsors[0];

  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 60 }); // window [100, 160]
  assert.deepEqual([frame().clockRemainSec, frame().clockTotalSec], [60, 60], 'a fresh badge is fully lit');

  elapsed = 120; timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } });
  assert.deepEqual([frame().clockRemainSec, frame().clockTotalSec], [40, 60], 'drains: 40 of 60 left');

  sponsors.ingest({ username: 'Alice', cents: 500, notionalSec: 30 }); // still active -> window [100, 190]
  assert.deepEqual([frame().clockRemainSec, frame().clockTotalSec], [70, 90], 'stacking keeps the start, extends the end');

  elapsed = 300; timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } }); // expired at 190
  assert.deepEqual([frame().clockRemainSec, frame().clockTotalSec], [0, 90], 'expired: remain 0, the old window length is inert');

  sponsors.ingest({ username: 'Alice', cents: 500, notionalSec: 45 }); // fresh window [300, 345]
  assert.deepEqual([frame().clockRemainSec, frame().clockTotalSec], [45, 45], 'a mint after expiry starts a fresh, fully-lit window');
});

test('ingest: identity keys are case-insensitive on username', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Bob', cents: 100, notionalSec: 10 });
  sponsors.ingest({ username: 'BOB', cents: 100, notionalSec: 10 });
  assert.equal(sponsors.__test.state.size, 1);
  assert.equal(sponsors.__test.state.get('n:bob').weightSec, 20);
});

test('ingest: a paused night (elapsedSec frozen) leaves the remaining badge time unchanged between reads', () => {
  const elapsedFixed = 300;
  const timer = fakeTimer({ active: true, elapsedSec: elapsedFixed });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Paused', cents: 100, notionalSec: 50 });

  const a = sponsors.__test.buildFrame().sponsors[0].clockRemainSec;
  const b = sponsors.__test.buildFrame().sponsors[0].clockRemainSec;
  assert.equal(a, b);
});

test('ingest: anonymous is excluded from the live pool', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Anonymous', cents: 1000, notionalSec: 1000 });
  sponsors.ingest({ username: 'anonymous', cents: 1000, notionalSec: 1000 });
  sponsors.ingest({ username: 'Real', cents: 100, notionalSec: 100 });
  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors.length, 1);
  assert.equal(frame.sponsors[0].name, 'Real');
});

test('ingest: guards against a missing username or non-positive cents', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: '', cents: 100, notionalSec: 10 });
  sponsors.ingest({ username: null, cents: 100, notionalSec: 10 });
  sponsors.ingest({ username: 'X', cents: 0, notionalSec: 10 });
  sponsors.ingest({ username: 'X', cents: -5, notionalSec: 10 });
  assert.equal(sponsors.__test.state.size, 0);
});

test('ingest: a non-finite/negative notionalSec (notionalFor fell back oddly) degrades to zero weight, never NaN', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'X', cents: 100, notionalSec: NaN });
  sponsors.ingest({ username: 'X', cents: 100, notionalSec: -5 });
  const entry = sponsors.__test.state.get('n:x');
  assert.equal(entry.weightSec, 0);
  assert.ok(Number.isFinite(entry.clockUntilElapsed));
});

// ── frame shape ──────────────────────────────────────────────────────────────

test('frame: weightPct sums to ~100, sorted by weight desc', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 500 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Big', cents: 9000, notionalSec: 900 });
  sponsors.ingest({ username: 'Small', cents: 1000, notionalSec: 100 });

  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors[0].name, 'Big');
  assert.equal(frame.sponsors[1].name, 'Small');
  const sum = frame.sponsors.reduce((a, s) => a + s.weightPct, 0);
  assert.ok(Math.abs(sum - 100) < 0.2, `weightPct sum ${sum} not ~100`);
});

test('frame: clockRemainSec floors at 0 once a badge has expired', () => {
  let elapsed = 100;
  const timer = fakeTimer({ active: true, elapsedSec: elapsed });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Expired', cents: 100, notionalSec: 10 }); // clockUntilElapsed = 110

  elapsed = 500;
  timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } });
  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors[0].clockRemainSec, 0);
});

test('frame: the sponsor list is capped at 50 entries, and a capped frame can legitimately sum to LESS than 100%', () => {
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  for (let i = 0; i < 60; i++) {
    sponsors.ingest({ username: `user${i}`, cents: 100 + i, notionalSec: 100 + i });
  }
  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors.length, 50);
  assert.equal(sponsors.__test.state.size, 60, 'the pool itself keeps everyone — only the FRAME is capped');
  // The bottom 10 sponsors' share is simply cut, never redistributed onto
  // the visible 50 — weightPct means "share of everyone", not "share of the
  // displayed list", so the displayed sum falls meaningfully short of 100.
  const sum = frame.sponsors.reduce((a, s) => a + s.weightPct, 0);
  assert.ok(sum < 99, `a capped frame's weightPct should sum well under 100 (got ${sum})`);
});

// Review round 2, minor 5a: weightSec ties must sort deterministically, or
// the 50-cap can select a DIFFERENT set of sponsors across two runs over
// identical data (the reviewer proved this happens with Map insertion order
// alone). Two identical insertion orders, reversed, must produce the SAME
// sorted output either way.
test('frame: weightSec ties break deterministically by name, regardless of insertion order', () => {
  const timerA = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsorsA = createSponsors({ pool: null, broadcast: () => {}, timer: timerA, getStreamId: async () => null });
  sponsorsA.ingest({ username: 'Zebra', cents: 100, notionalSec: 50 });
  sponsorsA.ingest({ username: 'Apple', cents: 100, notionalSec: 50 });
  sponsorsA.ingest({ username: 'Mango', cents: 100, notionalSec: 50 });

  const timerB = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsorsB = createSponsors({ pool: null, broadcast: () => {}, timer: timerB, getStreamId: async () => null });
  sponsorsB.ingest({ username: 'Mango', cents: 100, notionalSec: 50 });
  sponsorsB.ingest({ username: 'Apple', cents: 100, notionalSec: 50 });
  sponsorsB.ingest({ username: 'Zebra', cents: 100, notionalSec: 50 });

  const namesA = sponsorsA.__test.buildFrame().sponsors.map((s) => s.name);
  const namesB = sponsorsB.__test.buildFrame().sponsors.map((s) => s.name);
  assert.deepEqual(namesA, ['Apple', 'Mango', 'Zebra']);
  assert.deepEqual(namesA, namesB, 'identical weights, opposite insertion order — must sort identically');
});

test('frame: an empty pool has an empty, valid frame (no NaN, no divide-by-zero)', () => {
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  assert.deepEqual(sponsors.__test.buildFrame(), { type: 'sponsorState', sponsors: [] });
});

// ── heartbeat: change-detect + bounded resync ────────────────────────────────

test('heartbeatTick: unchanged state skips 3 ticks then resyncs on the 4th', () => {
  const broadcasts = [];
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'A', cents: 100, notionalSec: 10 }); // ingest's own emit()
  const base = broadcasts.length;

  sponsors.__test.heartbeatTick(); // unchanged #1
  sponsors.__test.heartbeatTick(); // unchanged #2
  sponsors.__test.heartbeatTick(); // unchanged #3
  assert.equal(broadcasts.length, base, 'no broadcast on unchanged ticks 1-3');

  sponsors.__test.heartbeatTick(); // unchanged #4 -> resync
  assert.equal(broadcasts.length, base + 1, 'the 4th unchanged tick still resyncs');
});

test('heartbeatTick: a real state change (elapsed moving the clock) broadcasts immediately and resets the resync counter', () => {
  const broadcasts = [];
  let elapsed = 0;
  const timer = fakeTimer({ active: true, elapsedSec: elapsed });
  const sponsors = createSponsors({ pool: null, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'A', cents: 100, notionalSec: 100 });
  const base = broadcasts.length;

  elapsed = 50; // changes clockRemainSec -> the frame differs
  timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } });
  sponsors.__test.heartbeatTick();
  assert.equal(broadcasts.length, base + 1);

  // and the counter is back at 0: the next THREE unchanged ticks stay silent
  sponsors.__test.heartbeatTick();
  sponsors.__test.heartbeatTick();
  sponsors.__test.heartbeatTick();
  assert.equal(broadcasts.length, base + 1);
});

// Review round 2, IMPORTANT: clockRemainSec ticks down every real second a
// night runs, so hashing its EXACT value defeated change-detection entirely
// — the reviewer measured 20/20 broadcasts (every single tick) for a live
// badge with nothing else changing, instead of the resync-only 5/20. The fix
// buckets clockRemainSec in the KEY only (buildFrame's own output stays
// exact — this is purely about what counts as "changed" for dedup).
test('heartbeatTick: a live, merely-ticking-down badge with unchanged weights dedups to the resync-only cadence (5 of 20)', () => {
  const broadcasts = [];
  let elapsed = 0;
  const timer = fakeTimer({ active: true, elapsedSec: elapsed });
  const sponsors = createSponsors({ pool: null, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Live', cents: 100, notionalSec: 510 }); // clockUntilElapsed = 510
  const base = broadcasts.length;

  for (let tick = 1; tick <= 20; tick++) {
    elapsed = tick; // the badge genuinely counts down, 1s per tick — not frozen
    timer.snapshot = () => ({ night: { active: true, elapsedSec: elapsed } });
    sponsors.__test.heartbeatTick();
  }

  // remain ranges 509 down to 490 across the 20 ticks — comfortably inside
  // ONE bucket (width 60s) the whole time, so every broadcast here comes
  // from the resync floor alone: 20 ticks / HB_RESYNC_EVERY(4) = 5.
  assert.equal(broadcasts.length - base, 5,
    'a live, merely-ticking-down badge with no real change must dedup down to the resync-only cadence, not fire every tick');
});

test('heartbeatTick: a badge crossing to expiry (remain hits exactly 0) forces a broadcast, independent of the resync counter', () => {
  const broadcasts = [];
  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool: null, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Expiring', cents: 100, notionalSec: 6 }); // clockUntilElapsed = 6
  const base = broadcasts.length;

  timer.snapshot = () => ({ night: { active: true, elapsedSec: 4 } }); // remain=2, same bucket as at ingest
  sponsors.__test.heartbeatTick();
  assert.equal(broadcasts.length, base, 'remain=2: same bucket as at ingest, and only 1 unchanged tick (resync not due) — no broadcast');

  timer.snapshot = () => ({ night: { active: true, elapsedSec: 5 } }); // remain=1, still the same bucket
  sponsors.__test.heartbeatTick();
  assert.equal(broadcasts.length, base, 'remain=1: still the same bucket, only 2 unchanged ticks — still no broadcast');

  timer.snapshot = () => ({ night: { active: true, elapsedSec: 6 } }); // remain=0 — the crossing
  sponsors.__test.heartbeatTick();
  assert.equal(broadcasts.length, base + 1,
    'remain hit exactly 0 (bucket 1 -> 0): forces a broadcast after only 3 total ticks — well short of the 4-tick resync floor, ' +
    'so this broadcast can only be the crossing, not the resync');
});

// ── restart recompute ────────────────────────────────────────────────────────

test('init: off-stream with nothing on record is empty (and never throws)', async () => {
  const pool = fakePool({}); // sessions table empty
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => null });
  await sponsors.init();
  assert.equal(sponsors.__test.state.size, 0);
});

test('init: off-stream PRELOADS the last SUPPORTED session — skipping a later supporter-less test session', async () => {
  // Prod's exact shape: a real stream with donors, then a 2-minute deploy-test
  // session with no support rows. The credit line must cycle the real one.
  const events = {
    real: [
      { user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'c2', username: 'Eli',  amount_usd: '30.00', created_at: new Date('2026-08-22T05:00:00Z') },
    ],
    testsesh: [],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [
      { stream_id: 'real',     started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') },
      { stream_id: 'testsesh', started_at: new Date('2026-08-24T03:18:00Z'), ended_at: new Date('2026-08-24T03:20:00Z') },
    ],
    events,
  });
  const broadcasts = [];
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  await sponsors.init();
  assert.equal(sponsors.__test.state.size, 2, 'both real donors preloaded');
  assert.equal(entryOf(sponsors.__test.state, 'c2').weightSec, 2700, 'FULL weight off-stream ($30 @ $40/h = 2700s) — nothing to discount against');
  assert.equal(entryOf(sponsors.__test.state, 'c2').clockUntilElapsed, 0, 'no badges off-stream — no clock to wear one on');
  const frame = broadcasts.at(-1);
  assert.deepEqual(frame.sponsors.map((s) => s.name), ['Eli', 'Dana'], 'the credit line has names to cycle before the night starts');
});

test('init: on-stream, the PREVIOUS cohort also skips supporter-less sessions', async () => {
  const events = {
    real: [{ user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-22T04:00:00Z') }],
    testsesh: [],
    now: [],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [
      { stream_id: 'real',     started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') },
      { stream_id: 'testsesh', started_at: new Date('2026-08-24T03:18:00Z'), ended_at: new Date('2026-08-24T03:20:00Z') },
      { stream_id: 'now',      started_at: new Date('2026-08-25T03:00:00Z'), ended_at: null },
    ],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();
  assert.equal(entryOf(sponsors.__test.state, 'c1').weightSec, 900 * 0.25, 'Dana rides in as the previous cohort at 0.25x, not lost behind the empty test session');
});

test('init: Qorm-spend rows never enter the pool, and a spends-only session is not a supported one', async () => {
  const SPENDS = ['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound'];
  const events = {
    real: [
      { user_id: 'c1', username: 'Dana',   amount_usd: '10.00', event_type: 'donation', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'c9', username: 'Sticky', amount_usd: '2.00',  event_type: 'sticker',  created_at: new Date('2026-08-22T04:30:00Z') },
      { user_id: 'c9', username: 'Sticky', amount_usd: '5.00',  event_type: 'cheer',    created_at: new Date('2026-08-22T04:40:00Z') },
    ],
    spendsOnly: [
      { user_id: 'c9', username: 'Sticky', amount_usd: '5.00', event_type: 'sticker', created_at: new Date('2026-08-24T04:00:00Z') },
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [
      { stream_id: 'real',       started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') },
      { stream_id: 'spendsOnly', started_at: new Date('2026-08-24T03:18:00Z'), ended_at: new Date('2026-08-24T05:20:00Z') },
    ],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => null, excludeEventTypes: SPENDS });
  await sponsors.init();
  assert.deepEqual(poolIds(sponsors.__test.state), ['u:c1'],
    'the later spends-only session must be skipped for the real one, and its sticker/cheer rows must not become sponsors');
});

test('init: the exclusion list rides every fold as a parameter — replay and both session queries', async () => {
  const SPENDS = ['cheer', 'sticker'];
  const seen = [];
  const pool = fakePool({
    timerRow: noNightRow, seen,
    sessions: [
      { stream_id: 'prev', started_at: new Date('2026-08-21T03:00:00Z'), ended_at: new Date('2026-08-21T10:00:00Z') },
      { stream_id: 'now',  started_at: new Date('2026-08-22T03:00:00Z'), ended_at: null },
    ],
    events: { prev: [{ user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-21T04:00:00Z') }], now: [] },
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now', excludeEventTypes: SPENDS });
  await sponsors.init();
  const folds = seen.filter((q) => /stream\.support_events/.test(q.sql));
  assert.ok(folds.length >= 3, `expected the previous-session query and two replays, saw ${folds.length}`);
  for (const q of folds) assert.deepEqual(q.params[q.params.length - 1], SPENDS, `a fold ran without the exclusion: ${q.sql.slice(0, 60)}`);
});

test('init: every support_events fold is NULL-tolerant — a bare `<> ALL` would silently drop untyped rows', async () => {
  // event_type is nullable (schema.sql) and money.js stores a blank kind as
  // NULL. In Postgres, `NULL <> ALL(ARRAY[...])` evaluates to NULL, and
  // WHERE/EXISTS drops a NULL row — silently, with no error anywhere. This
  // file's own `funding` fixture predicate (`!excluded.includes(e.event_type)`)
  // cannot catch that: JS's `undefined` is simply never IN a list of strings,
  // so a bare, un-COALESCEd query would still satisfy a behavioural fixture
  // test. The rule lives in the SQL, so every fold's SQL text is asserted
  // here directly.
  const seen = [];
  const pool = fakePool({
    timerRow: noNightRow, seen,
    sessions: [
      { stream_id: 'prev', started_at: new Date('2026-08-21T03:00:00Z'), ended_at: new Date('2026-08-21T10:00:00Z') },
      { stream_id: 'now',  started_at: new Date('2026-08-22T03:00:00Z'), ended_at: null },
    ],
    events: { prev: [{ user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-21T04:00:00Z') }], now: [] },
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now', excludeEventTypes: ['cheer'] });
  await sponsors.init();
  const folds = seen.filter((q) => /stream\.support_events/.test(q.sql));
  assert.ok(folds.length >= 3, `expected the previous-session query and two replays, saw ${folds.length}`);
  for (const q of folds) {
    assert.match(q.sql, /NOT \((?:e\.)?platform IN \('native'[^)]*\) AND COALESCE\((?:e\.)?event_type, ''\) = ANY\(\$\d::text\[\]\)\)/,
      `a bare event_type <> ALL(...) (or a platform-blind exclusion) silently mishandles rows: ${q.sql.slice(0, 80)}`);
  }
});

test("the exclusion is platform-scoped: an external platform's row sharing a coin-kind event_type is KEPT, not excluded", async () => {
  // Qorm spends only ever arrive under the site's own platform id (money.js). Before this
  // fix the SQL excluded on event_type ALONE, so if any external producer
  // ever wrote event_type='cheer' — not far-fetched: stream-ingest/lib/alerts.js
  // already emits `eventType: 'bits'` with `label: 'cheered'`, and 'sticker' is
  // one rename from 'supersticker' — real platform money would be silently
  // dropped from every fold, the same class of bug as the NULL case above
  // through a different door.
  const events = {
    real: [
      // Same event_type as a Qorm spend, but a DIFFERENT platform: real
      // money, must survive the exclusion.
      { user_id: 'tw1', username: 'TwitchDonor', amount_usd: '7.00', event_type: 'cheer', platform: 'twitch', created_at: new Date('2026-08-22T04:00:00Z') },
      // The actual Qorm spend this exclusion exists for: same event_type,
      // the site's own platform — must be excluded.
      { user_id: 'c9', username: 'Sticky', amount_usd: '5.00', event_type: 'cheer', platform: NATIVE_PLATFORM, created_at: new Date('2026-08-22T04:10:00Z') },
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => null, excludeEventTypes: ['cheer'] });
  await sponsors.init();
  assert.deepEqual(poolIds(sponsors.__test.state), ['u:tw1'],
    "a platform='twitch' event_type='cheer' row must enter the pool — only the site's own coin-spend rows are spectacle");
});

test('init: a DB failure is swallowed and still broadcasts an (empty) frame — never throws', async () => {
  const broadcasts = [];
  const pool = { query: async () => { throw new Error('db down'); } };
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => 'now' });
  await sponsors.init();
  assert.deepEqual(broadcasts, [{ type: 'sponsorState', sponsors: [] }]);
});

test('init: no active night + no usable rate configured — raw cents as a last-resort weight, no badges', async () => {
  const events = {
    now: [
      { user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-24T00:01:00Z') },
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 0 }); // no rate configured at all
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();

  const entry = entryOf(sponsors.__test.state, 'c1');
  assert.equal(entry.weightSec, 1000); // $10.00 -> 1000 cents, the last-resort proxy
  assert.equal(entry.clockUntilElapsed, 0); // no active night => no badges
});

// With no active night but a REAL usdPerHour configured, a replayed donation
// must convert through the SAME legacy flat rate the LIVE path quotes via
// timer.convertNotional for the identical case — not the raw-cents proxy
// (reserved for the genuinely rate-less case above). Cross-checked against a REAL createTimer instance
// for authoritative parity, not just a re-statement of the formula.
test('init: no active night + a configured usdPerHour — replay matches the LIVE legacy-rate quote exactly (restart-continuity)', async () => {
  const liveTimer = createTimer({ broadcast: () => {}, obs: null, pool: null });
  liveTimer.setConfig({ hr: 40 }); // $40/hr, no night — legacy flat-rate world
  const liveQuote = liveTimer.convertNotional(10); // what a live $10 donation would notionally be worth

  const events = { now: [
    { user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-24T00:01:00Z') },
  ] };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();

  const entry = entryOf(sponsors.__test.state, 'c1');
  assert.equal(liveQuote, 900); // $10 / $40/hr * 3600 = 900s — sanity on the hand math too
  assert.equal(entry.weightSec, liveQuote, 'replayed no-night notional must match the LIVE convertNotional quote');
});

test('init: current-session rows buy forward through the SAME night-math curve, frontier evolving event to event', async () => {
  const durationSec = 4 * 3600;
  const seedSec = 3600;
  const priceCents = 24000;
  const blocks = layoutBlocks(durationSec, seedSec, priceCents);
  const nightStarted = new Date('2026-08-24T00:00:00Z');

  const timerRow = {
    night_active: true,
    night_duration_sec: durationSec,
    night_elapsed_sec: 5400, // 1.5h in
    night_seed_sec: seedSec,
    night_price_cents: priceCents,
    night_blocks: blocks,
    night_started_at: nightStarted,
  };

  const ev1 = { user_id: 'u1', username: 'Alice', amount_usd: '10.00', created_at: new Date(nightStarted.getTime() + 10 * 60_000) };
  const ev2 = { user_id: 'u1', username: 'Alice', amount_usd: '5.00', created_at: new Date(nightStarted.getTime() + 20 * 60_000) };
  const ev3 = { user_id: 'u2', username: 'Bob', amount_usd: '20.00', created_at: new Date(nightStarted.getTime() + 30 * 60_000) };

  const pool = fakePool({
    timerRow,
    sessions: [{ stream_id: 'now', started_at: nightStarted, ended_at: null }],
    events: { now: [ev3, ev1, ev2] }, // out of order in storage — init() must sort by created_at
  });

  const timer = fakeTimer({ active: true, elapsedSec: timerRow.night_elapsed_sec });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();

  // Hand-computed against the SAME night-math core, independently.
  let frontier = seedSec;
  const r1 = convertCents(1000, frontier, blocks, durationSec); frontier += r1.seconds;
  const r2 = convertCents(500, frontier, blocks, durationSec); frontier += r2.seconds;
  const r3 = convertCents(2000, frontier, blocks, durationSec); frontier += r3.seconds;

  const state = sponsors.__test.state;
  assert.equal(entryOf(state, 'u1').weightSec, r1.seconds + r2.seconds);
  assert.equal(entryOf(state, 'u2').weightSec, r3.seconds);

  // badges: created_at - night_started_at, clamped to [0, elapsedSec], stacked additively
  const badge1 = Math.min(Math.max(600, 0), 5400);   // 10 min in
  const badge2 = Math.min(Math.max(1200, 0), 5400);  // 20 min in
  const expectedAliceClock = Math.max(Math.max(0, badge1) + r1.seconds, badge2) + r2.seconds;
  assert.equal(entryOf(state, 'u1').clockUntilElapsed, expectedAliceClock);
});

test('init: previous session rows join the pool at 0.25x weight, with no badges (no-night degenerate case)', async () => {
  const currentStreamId = 'now';
  const prevStreamId = 'prev';
  const prevStarted = new Date('2026-08-23T00:00:00Z');
  const prevEnded = new Date('2026-08-23T04:00:00Z');
  const nowStarted = new Date('2026-08-24T00:00:00Z');

  const prevEvent = { user_id: 'p1', username: 'Carl', amount_usd: '40.00', created_at: new Date(prevStarted.getTime() + 1000) };
  const curEvent = { user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date(nowStarted.getTime() + 1000) };

  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [
      { stream_id: prevStreamId, started_at: prevStarted, ended_at: prevEnded },
      { stream_id: currentStreamId, started_at: nowStarted, ended_at: null },
    ],
    events: { [prevStreamId]: [prevEvent], [currentStreamId]: [curEvent] },
  });

  // No rate configured either — both cohorts fall to the SAME raw-cents
  // last resort, so 0.25x is trivially visible on the raw numbers here. The
  // NON-trivial case (a real curve, non-floor price) is pinned separately
  // below — this test is just the simplest sanity check on the multiplier.
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => currentStreamId });
  await sponsors.init();

  const state = sponsors.__test.state;
  assert.equal(entryOf(state, 'c1').weightSec, 1000);         // $10 -> 1000 cents, full weight
  assert.equal(entryOf(state, 'p1').weightSec, 4000 * 0.25);  // $40 -> 4000 cents, at 0.25x
  assert.equal(entryOf(state, 'p1').clockUntilElapsed, 0);    // previous session never gets a badge
});

// The previous cohort's 0.25x must be applied in the same unit as the current
// one. Weighting the previous session in cents while the current session is
// weighted in seconds from a ramping curve makes the effective multiplier
// drift with the night's price.
//
// So the previous session replays through the same curve as tonight, with its
// own fresh frontier. Proof: two different donors on two different
// sessions give the identical $ amount, from the identical starting
// frontier (0), through the identical (non-floor-priced) curve — their raw
// notional-in-seconds must be EXACTLY equal, and the previous donor's final
// weightSec must be EXACTLY 0.25x the current donor's, not "close to".
test('init: previous session replays through the SAME curve as tonight — 0.25x holds EXACTLY under a non-floor night price', async () => {
  const currentStreamId = 'now';
  const prevStreamId = 'prev';
  const prevStarted = new Date('2026-08-23T00:00:00Z');
  const prevEnded = new Date('2026-08-23T04:00:00Z');
  const nowStarted = new Date('2026-08-24T00:00:00Z');

  // A 2h night with NO seed, priced well above the $24/h floor (a
  // requiredCentsPerDay-driven price, per the reviewer's scenario) — two
  // hourly blocks with the ramping weight curve actually doing something,
  // not the degenerate single-block flat-rate case the OTHER tests use.
  const durationSec = 2 * 3600;
  const seedSec = 0;
  const priceCents = 100_000; // $1000 — well above the $24/h ($48 for 2h) floor
  const blocks = layoutBlocks(durationSec, seedSec, priceCents);
  assert.ok(blocks.length === 2 && blocks[0].cents !== blocks[1].cents, 'sanity: the curve must actually ramp for this test to mean anything');

  const timerRow = {
    night_active: true, night_duration_sec: durationSec, night_elapsed_sec: 0,
    night_seed_sec: seedSec, night_price_cents: priceCents, night_blocks: blocks,
    night_started_at: nowStarted,
  };

  const sameDollarAmount = '50.00'; // identical for both cohorts, on purpose
  const prevEvent = { user_id: 'p1', username: 'Carl', amount_usd: sameDollarAmount, created_at: new Date(prevStarted.getTime() + 1000) };
  const curEvent = { user_id: 'c1', username: 'Dana', amount_usd: sameDollarAmount, created_at: new Date(nowStarted.getTime() + 1000) };

  const pool = fakePool({
    timerRow,
    sessions: [
      { stream_id: prevStreamId, started_at: prevStarted, ended_at: prevEnded },
      { stream_id: currentStreamId, started_at: nowStarted, ended_at: null },
    ],
    events: { [prevStreamId]: [prevEvent], [currentStreamId]: [curEvent] },
  });

  const timer = fakeTimer({ active: true, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => currentStreamId });
  await sponsors.init();

  const state = sponsors.__test.state;
  const curWeight = entryOf(state, 'c1').weightSec;
  const prevWeight = entryOf(state, 'p1').weightSec;
  assert.ok(curWeight > 0, 'sanity: the curve actually priced the donation');
  assert.equal(prevWeight, curWeight * 0.25, '0.25 must mean 0.25, exactly, under a ramping non-floor-priced curve');
  assert.equal(entryOf(state, 'p1').clockUntilElapsed, 0, 'the previous cohort still never gets a badge');
});

// Once the frontier reaches durationSec ("gold"), a replay that discarded
// convertCents's overflowCents would give every later donor zero weight and
// zero badge. Mirrors timer.js convertNotional: value the overflow at the LAST block's per-second rate as an "encore" and fold
// it into the notional, exactly like the live path already does.
//
// Proof of parity: fund a small night live (via a REAL createTimer, past
// gold) and take its OWN convertNotional() quote for a THIRD, entirely
// post-gold donation as ground truth — then replay the SAME three donations
// through sponsors.js from a fixture built off that same timer's own
// persisted block layout, and assert the post-gold donor's replayed weight
// equals the live quote exactly (not zero).
test('init: CRITICAL — a post-gold replay row gets the SAME notional the live path (timer.convertNotional) grants, not zero', async () => {
  const now = Date.now();
  const liveTimer = createTimer({ broadcast: () => {}, obs: null, pool: null });
  liveTimer.startNight({ endLocal: '+1h', seedSec: 0, priceCents: 3600, now }); // 1h night, flat $0.01/s (rate=1c/s) for hand-checkable numbers
  liveTimer.addMoney(30); // frontier 0 -> 3000s (of 3600s sellable)
  liveTimer.addMoney(10); // frontier 3000 -> 3600s (GOLD), 400c banked to overflow
  const livePostGoldNotional = liveTimer.convertNotional(20); // the THIRD donor, entirely post-gold
  assert.ok(livePostGoldNotional > 0, 'sanity: the live quote itself must be nonzero for this test to mean anything');

  const st = liveTimer.__test.st;
  const nightStartedAt = st.night.startedAt;
  const timerRow = {
    night_active: true,
    night_duration_sec: st.night.durationSec,
    night_elapsed_sec: st.night.elapsedSec,
    night_seed_sec: st.night.seedSec,
    night_price_cents: st.night.priceCents,
    night_blocks: st.night.blocks,
    night_started_at: nightStartedAt,
  };
  const t0 = nightStartedAt.getTime();
  const events = { now: [
    { user_id: 'a', username: 'DonorA', amount_usd: '30.00', created_at: new Date(t0 + 1000) },
    { user_id: 'b', username: 'DonorB', amount_usd: '10.00', created_at: new Date(t0 + 2000) },
    { user_id: 'c', username: 'DonorC', amount_usd: '20.00', created_at: new Date(t0 + 3000) }, // entirely post-gold
  ] };
  const pool = fakePool({
    timerRow,
    sessions: [{ stream_id: 'now', started_at: nightStartedAt, ended_at: null }],
    events,
  });

  const timer = fakeTimer({ active: true, elapsedSec: st.night.elapsedSec });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();

  const donorC = entryOf(sponsors.__test.state, 'c');
  assert.ok(donorC, 'donor C should be in the pool');
  assert.equal(donorC.weightSec, livePostGoldNotional, 'the bug: discarding overflow would leave this at 0, not the live quote');
});

test('init: a session with no prior ended session has no previous-session contribution (not an error)', async () => {
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'only', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events: { only: [] },
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'only' });
  await sponsors.init();
  assert.equal(sponsors.__test.state.size, 0);
});

test('init: Anonymous rows are excluded from the replayed pool', async () => {
  const anonEvent = { user_id: 'anon-id', username: 'Anonymous', amount_usd: '50.00', created_at: new Date('2026-08-24T00:01:00Z') };
  const realEvent = { user_id: 'r1', username: 'Real', amount_usd: '5.00', created_at: new Date('2026-08-24T00:02:00Z') };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events: { now: [anonEvent, realEvent] },
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();

  assert.equal(sponsors.__test.state.size, 1);
  assert.ok(!!entryOf(sponsors.__test.state, 'r1'));
  assert.ok(!entryOf(sponsors.__test.state, 'anon-id'));
});

test('init: a zero/invalid amount_usd row is skipped, not counted as a zero-weight sponsor', async () => {
  const events = { now: [
    { user_id: 'z1', username: 'Zero', amount_usd: '0.00', created_at: new Date('2026-08-24T00:01:00Z') },
  ] };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();
  assert.equal(sponsors.__test.state.size, 0);
});

test('init() broadcasts the loaded frame once, at the end', async () => {
  const broadcasts = [];
  const events = { now: [
    { user_id: 'c1', username: 'Dana', amount_usd: '10.00', created_at: new Date('2026-08-24T00:01:00Z') },
  ] };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events,
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => 'now' });
  await sponsors.init();
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].sponsors[0].name, 'Dana');
});

// ── documented limitation: live vs replay identity keying ───────────────────
//
// See sponsors.js's header comment. supportBar.add(takeHome, username) is
// never handed a canonical id — only a username — so a LIVE ingest can only
// key by lowercased username, while a DB replay always has support_events'
// NOT NULL user_id to key by. This is not a bug this task can fix (it would
// mean threading a canonical id through supportBar/alert), but it IS a real,
// checkable behavior: pinned here so it stays a documented, known shape
// rather than a silent surprise.
test('live + replay key the SAME identity when the live payload carries the canonical id', async () => {
  const pastEvent = { user_id: 'u1', username: 'Regular', amount_usd: '10.00', created_at: new Date('2026-08-24T00:01:00Z') };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events: { now: [pastEvent] },
  });
  const timer = fakeTimer({ active: false, elapsedSec: 0 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init();
  assert.equal(sponsors.__test.state.size, 1);

  sponsors.ingest({ username: 'Regular', userId: 'u1', cents: 500, notionalSec: 500 });
  assert.equal(sponsors.__test.state.size, 1, 'same canonical, same row — weight stacks on the replayed entry');
  assert.equal(entryOf(sponsors.__test.state, 'u1').weightSec, 1500, 'the replay with no usable rate weighs raw cents (1000) + 500 live');

  // A payload with NO id (an older caller) still falls back to the username
  // key — and still splits, which is the documented reason to pass the id.
  sponsors.ingest({ username: 'Regular', cents: 500, notionalSec: 500 });
  assert.equal(sponsors.__test.state.size, 2, 'no id, no join: the username key is its own row');
});

test('init: an active night with no sellable blocks (seed covers the whole clock) quotes zero, never throws', async () => {
  // Mirrors timer.js's own convertNotional docs: a night whose seed swallows
  // the entire duration has nothing left to price — night-math's convertCents
  // degrades to 0 seconds / full overflow for an empty blocks array rather
  // than throwing, and this must not crash the replay.
  const timerRow = {
    night_active: true, night_duration_sec: 3600, night_elapsed_sec: 100,
    night_seed_sec: 3600, night_price_cents: 0, night_blocks: [],
    night_started_at: new Date('2026-08-24T00:00:00Z'),
  };
  const events = { now: [
    { user_id: 'u1', username: 'Nobody', amount_usd: '25.00', created_at: new Date('2026-08-24T00:01:00Z') },
  ] };
  const pool = fakePool({
    timerRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events,
  });
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'now' });
  await sponsors.init(); // must not throw

  const entry = entryOf(sponsors.__test.state, 'u1');
  assert.equal(entry.weightSec, 0);
});

// ── The pool's night lifecycle ──────────────────────────────────────────────

test('ingest: with NO night active, a live donation earns weight but mints NO badge', () => {
  // The clock badge is worn for stream-minutes, "live streams only
  // — off-air money earns next-stream credit-pool weight, no badge". A badge
  // minted with no night running is worse than absent: `clockUntilElapsed` is
  // denominated in night-elapsed seconds, and with no night the ember never
  // moves — so it counts down NEVER, and the badge sits on the viewer's name
  // until a restart (whose replay refuses to mint it) quietly deletes it.
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });

  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 900 });

  const frame = sponsors.__test.buildFrame();
  assert.equal(frame.sponsors.length, 1, 'the donor still belongs in the credit pool');
  assert.equal(frame.sponsors[0].weightPct, 100, 'weight still accrues with no night — only the badge is night-scoped');
  assert.equal(sponsors.__test.state.get('n:alice').weightSec, 900);
  assert.equal(frame.sponsors[0].clockRemainSec, 0, 'a badge whose clock can never tick must never be minted');
});

test('ingest: with a night active the badge is minted exactly as before (the gate is the night, not the money)', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 60 });
  assert.equal(sponsors.__test.buildFrame().sponsors[0].clockRemainSec, 60);
});

test('reset(): a second night in one process drops last night\'s live rows — 0.25x weight, no resurrected badges', () => {
  // Without a night lifecycle, night 1's donors sit in the live map at FULL
  // weight with `clockUntilElapsed` denominated in an `elapsedSec` that
  // `startNight` resets to 0 — so opening night 2 in the same process would
  // re-light every one of last night's badges and rank last night's cohort as
  // if it were tonight's.
  const s1 = { stream_id: 'S1', started_at: new Date('2026-08-23T02:00:00Z'), ended_at: new Date('2026-08-23T10:00:00Z') };
  const s2 = { stream_id: 'S2', started_at: new Date('2026-08-24T02:00:00Z'), ended_at: null };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [s1, s2],
    events: {
      S1: [{ user_id: 'u1', username: 'Alice', amount_usd: '10.00', created_at: new Date('2026-08-23T03:00:00Z') }],
      S2: [],
    },
  });
  const timer = fakeTimer({ active: true, elapsedSec: 5000, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: () => {}, timer, getStreamId: async () => 'S2' });

  // Night 1, live: Alice's badge is running and her weight is the full notional.
  sponsors.ingest({ username: 'Alice', cents: 1000, notionalSec: 900 });
  assert.equal(sponsors.__test.state.get('n:alice').weightSec, 900, 'premise: the live row is at full weight');
  assert.ok(sponsors.__test.buildFrame().sponsors[0].clockRemainSec > 0, 'premise: her badge is live');

  // Night 2 opens: startNight zeroes night.elapsedSec, and the pool is rebuilt.
  timer.snapshot = () => ({ night: { active: true, elapsedSec: 0 }, usdPerHour: 40 });
  return sponsors.reset().then(() => {
    assert.equal(sponsors.__test.state.has('n:alice'), false,
      'last night\'s LIVE row survived the new night at full weight');
    const replayed = entryOf(sponsors.__test.state, 'u1');
    assert.ok(replayed, 'last night\'s cohort must come back from the ledger, not vanish');
    assert.equal(replayed.weightSec, 225, 'the previous session belongs at 0.25x (900 * 0.25)');
    assert.equal(sponsors.__test.buildFrame().sponsors[0].clockRemainSec, 0,
      'last night\'s badge was resurrected by an elapsedSec that startNight reset to 0');
  });
});

test('frame: "@name" and "name" are ONE row, shown bare (one sponsor is never credited twice)', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer, getStreamId: async () => null });
  const state = sponsors.__test.state;
  state.set('u:a', { name: '@Bram42', weightSec: 3000, clockUntilElapsed: 160, clockStartElapsed: 100 });
  state.set('u:b', { name: 'Bram42',  weightSec: 1800, clockUntilElapsed: 0,   clockStartElapsed: 0 });
  const frame = sponsors.currentFrame();
  assert.deepEqual(frame.sponsors.map((x) => x.name), ['Bram42'], 'one credit, the bare spelling');
  assert.equal(frame.sponsors[0].weightPct, 100);
  assert.equal(state.size, 2, 'the identity keys stay distinct underneath');
});

test('currentFrame() is the same frame emit() broadcasts — the connect push and the heartbeat cannot disagree', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 100 });
  const sent = [];
  const sponsors = createSponsors({ pool: null, broadcast: (f) => sent.push(f), timer, getStreamId: async () => null });
  sponsors.__test.state.set('u:a', { name: 'Dana', weightSec: 300, clockUntilElapsed: 160, clockStartElapsed: 100 });
  const emitted = sponsors.__test.emit ? sponsors.__test.emit() : null;
  const current = sponsors.currentFrame();
  assert.equal(current.type, 'sponsorState');
  if (emitted) assert.deepEqual(current, emitted);
});

// ── The name on the wire is the name chat shows ──────────────

test('replay: a donor whose canonical is linked to a site account is credited under site.users.display_name, the donation name kept as an alias', async () => {
  // Prod's exact case: Streamlabs "GadgetFan" (canonical a605…) is
  // @gadgetfan:site.test, display name "Gadget Qorm" — the name chat shows.
  const events = {
    real: [
      { user_id: 'a605', username: 'GadgetFan', amount_usd: '4.56', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'c2',   username: 'Kofi_Kim',   amount_usd: '30.00', created_at: new Date('2026-08-22T05:00:00Z') }, // no site account
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events,
    siteNames: { a605: 'Gadget Qorm' },
  });
  const broadcasts = [];
  const timer = fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 });
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer, getStreamId: async () => null });
  await sponsors.init();
  const frame = broadcasts.at(-1);
  const eddy = frame.sponsors.find((s) => s.name === 'Gadget Qorm');
  assert.ok(eddy, `credited under the chat name, got ${JSON.stringify(frame.sponsors.map((s) => s.name))}`);
  assert.deepEqual(eddy.aliases, ['GadgetFan'], 'the platform name rides along so a Twitch-side chat line still finds the badge');
  const kim = frame.sponsors.find((s) => s.name === 'Kofi_Kim');
  assert.ok(kim, 'no site account: the donation name stands');
  assert.deepEqual(kim.aliases, [], 'and it has no alias to carry');
  assert.equal(sponsors.__test.displayNames.get('c2'), null, 'a miss is cached as "no site name" — not re-queried per row');
});

test('replay: a donor who has NOT chosen to show their links keeps each donation name on its own row — no site name, no aliases', async () => {
  // Owner decision 2026-10-17: the credit line named a Twitch donation by the site account behind
  // it and listed the person's other donation names beside it — the cross-platform link, shown to
  // everyone watching. Without the opt-in neither the site name nor the pairing reaches the wire.
  const events = {
    real: [
      { user_id: 'a605', username: 'CaseyTwitch', amount_usd: '4.00', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'a605', username: 'CaseyKick',   amount_usd: '2.00', created_at: new Date('2026-08-22T04:30:00Z') },
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events,
    hiddenSites: { a605: 'Casey Site' },
  });
  const broadcasts = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer: fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 }), getStreamId: async () => null });
  await sponsors.init();
  const frame = broadcasts.at(-1);
  assert.deepEqual(frame.sponsors.map((s) => [s.name, s.aliases]), [['CaseyTwitch', []], ['CaseyKick', []]]);
  assert.ok(!JSON.stringify(frame).includes('Casey Site'), 'the site name behind a platform donation is on the public frame');
  sponsors.ingest({ username: 'CaseyKick', userId: 'a605', cents: 100, notionalSec: 10 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(broadcasts.at(-1).sponsors.map((s) => [s.name, s.aliases]), [['CaseyTwitch', []], ['CaseyKick', []]],
    'a live contribution stacks on its own name\'s row, still unpaired');
});

// Opting OUT must reach the credit line without a restart (security review on this slice): the
// site name was cached until init(), so a person who switched the link off stayed paired with
// their donation names on the public frame.
function optInRig() {
  const siteNames = { a605: 'Casey Site' };
  const hiddenSites = {};
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events: { real: [
      { user_id: 'a605', username: 'CaseyTwitch', amount_usd: '4.00', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'a605', username: 'CaseyKick',   amount_usd: '2.00', created_at: new Date('2026-08-22T04:30:00Z') },
    ] },
    siteNames, hiddenSites,
  });
  const frames = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 }), getStreamId: async () => null });
  const optOut = () => { hiddenSites.a605 = siteNames.a605; delete siteNames.a605; };
  return { sponsors, frames, optOut };
}

test('opt in -> one merged row; opt out + the links-changed notice -> the names apart on the next frame, no restart', async () => {
  const { sponsors, frames, optOut } = optInRig();
  await sponsors.init();
  assert.deepEqual(frames.at(-1).sponsors.map((s) => [s.name, s.aliases]), [['Casey Site', ['CaseyTwitch', 'CaseyKick']]]);
  optOut();
  await sponsors.linksChanged();
  const last = frames.at(-1);
  assert.deepEqual(last.sponsors.map((s) => [s.name, s.aliases]), [['CaseyTwitch', []], ['CaseyKick', []]]);
  assert.ok(!JSON.stringify(last).includes('Casey Site'));
});

test('backstop: without the notice, the periodic re-check sees the opt-out and rebuilds', async () => {
  const { sponsors, frames, optOut } = optInRig();
  await sponsors.init();
  assert.equal(await sponsors.__test.recheckOptIns(), false, 'nothing changed: no rebuild');
  optOut();
  assert.equal(await sponsors.__test.recheckOptIns(), true, 'the opt-out was not noticed');
  assert.deepEqual(frames.at(-1).sponsors.map((s) => s.name), ['CaseyTwitch', 'CaseyKick']);
});

// Overlapping rebuilds (security review): links-changed, a night start and the re-check can all
// trigger init(); two runs writing into one live pool doubled weights and interleaved names.
function countingRig() {
  const seen = [];
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events: { real: [
      { user_id: 'a605', username: 'CaseyTwitch', amount_usd: '4.00', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'b7',   username: 'Dana',        amount_usd: '2.00', created_at: new Date('2026-08-22T04:30:00Z') },
    ] },
    seen,
  });
  const frames = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 }), getStreamId: async () => null });
  const replays = () => seen.filter((q) => /FROM stream\.support_events(?:\s+e)?\s+WHERE (?:e\.)?stream_id = \$1/.test(q.sql)).length;
  return { sponsors, frames, replays };
}

test('overlapping triggers: one rebuild runs, exactly one more is queued, and the pool is the one a single rebuild makes', async () => {
  const single = countingRig();
  await single.sponsors.init();
  const expected = JSON.stringify(single.frames.at(-1));

  const { sponsors, frames, replays } = countingRig();
  const a = sponsors.linksChanged();
  const b = sponsors.linksChanged();
  const c = sponsors.reset();
  assert.equal(a, b, 'a trigger during a rebuild awaits the same promise');
  assert.equal(a, c);
  await Promise.all([a, b, c]);
  assert.equal(replays(), 2, 'the running rebuild plus exactly one more — never three, never interleaved');
  assert.equal(JSON.stringify(frames.at(-1)), expected, 'the pool after overlapping triggers differs from one clean rebuild');
  assert.equal(sponsors.__test.state.size, 2);
});

// While a rebuild reads the ledger, the live pool keeps changing (security review): an erasure
// the swap undid would bring a deleted person back; a credit the swap dropped would lose paid
// money from the credit line. Both are journaled and replayed onto the rebuilt pool.
function gatedRig(rows) {
  const inner = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events: { real: rows },
  });
  let open;
  const gate = new Promise((r) => { open = r; });
  let reading;
  const reached = new Promise((r) => { reading = r; });
  const pool = {
    async query(sql, params) {
      if (/FROM stream\.support_events(?:\s+e)?\s+WHERE (?:e\.)?stream_id = \$1/.test(sql)) { reading(); await gate; }
      return inner.query(sql, params);
    },
  };
  const frames = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 }), getStreamId: async () => null });
  return { sponsors, frames, open, reached };
}
const row = (id, user_id, username, usd) => ({ id, user_id, username, amount_usd: usd, created_at: new Date('2026-08-22T04:00:00Z') });

test('an erasure during a rebuild is still gone after the swap', async () => {
  const { sponsors, frames, open, reached } = gatedRig([row(1, 'gone1', 'CaseyTips', '5.00'), row(2, 'b7', 'Dana', '2.00')]);
  const rebuilt = sponsors.reset();
  await reached;                      // the rebuild has read nothing yet, and will read both rows
  sponsors.erase({ canonicalIds: ['gone1'], names: ['CaseyTips'] });
  open();
  await rebuilt;
  assert.deepEqual(frames.at(-1).sponsors.map((x) => x.name), ['Dana'], 'the swap brought the deleted person back');
});

test('a credit during a rebuild is still counted after the swap — once', async () => {
  const { sponsors, frames, open, reached } = gatedRig([row(1, 'b7', 'Dana', '2.00')]);
  const rebuilt = sponsors.reset();
  await reached;
  // A new donation whose ledger row the rebuild did NOT read, and one whose row it DID read (id 1).
  sponsors.ingest({ username: 'Eli', userId: 'e1', cents: 300, notionalSec: 270, ledgerId: '9' });
  sponsors.ingest({ username: 'Dana', userId: 'b7', cents: 200, notionalSec: 180, ledgerId: '1' });
  open();
  await rebuilt;
  const names = frames.at(-1).sponsors.map((x) => x.name);
  assert.ok(names.includes('Eli'), 'the swap dropped a paid credit');
  assert.equal(entryOf(sponsors.__test.state, 'e1').weightSec, 270);
  assert.equal(entryOf(sponsors.__test.state, 'b7').weightSec, 180, 'a credit the rebuild already read was counted twice');
});

test('a trigger after a rebuild finished starts a fresh one', async () => {
  const { sponsors, replays } = countingRig();
  await sponsors.linksChanged();
  await sponsors.linksChanged();
  assert.equal(replays(), 2);
});

test('the heartbeat runs the re-check every fourth tick', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'sponsors.js'), 'utf8');
  assert.match(src, /if \(ticks % RECHECK_EVERY === 0\) recheckOptIns\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(src, /const RECHECK_EVERY = 4;/);
  assert.match(src.trimEnd(), /module\.exports = \{ createSponsors \};$/, 'vacuity anchor: the end of sponsors.js');
});

test('the site-name lookup asks only for accounts that show their links', async () => {
  const seen = [];
  const sponsors = createSponsors({ pool: fakePool({ seen }), broadcast: () => {}, timer: fakeTimer({ active: false, elapsedSec: 0 }), getStreamId: async () => null });
  await sponsors.__test.resolveDisplayNames(['a605']);
  const q = seen.find((x) => /site\.platform_links/.test(x.sql));
  assert.ok(q, 'vacuity anchor: the lookup ran');
  assert.match(q.sql, /WHERE u\.show_links AND /);
  // Every account on the canonical must agree (security review): one account's opt-in is not
  // another's consent. Run against a throwaway Postgres: a canonical carrying an opted-in and a
  // not-opted account gets no site name.
  // The one predicate (pseudonym.js noOptOutSql, both link tables). A canonical whose natively
  // linked account opted out gets no site name — run against a throwaway Postgres.
  assert.match(q.sql, /AND NOT EXISTS \(SELECT 1 FROM \(\s*SELECT matrix_id FROM site\.platform_links WHERE canonical_id = x\.canonical_id\s+UNION SELECT platform_id FROM stream\.links WHERE platform IN \('native'[^)]*\) AND canonical = x\.canonical_id\s+\) consent_a JOIN site\.users consent_u ON consent_u\.matrix_id = consent_a\.matrix_id\s+WHERE NOT consent_u\.show_links\)/);
});

test('ingest: a canonical already resolved by the replay is named by its site account synchronously — the first frame is already right', async () => {
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'now', started_at: new Date('2026-08-24T00:00:00Z'), ended_at: null }],
    events: { now: [{ user_id: 'a605', username: 'GadgetFan', amount_usd: '4.56', created_at: new Date('2026-08-24T00:01:00Z') }] },
    siteNames: { a605: 'Gadget Qorm' },
  });
  const frames = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: true, elapsedSec: 100 }), getStreamId: async () => 'now' });
  await sponsors.init();
  const before = frames.length;
  sponsors.ingest({ username: 'Gadget_B', userId: 'a605', cents: 456, notionalSec: 60 }); // a different platform name this time
  assert.equal(frames.length, before + 1, 'exactly one frame for the contribution — no rename frame needed');
  assert.deepEqual(frames.at(-1).sponsors.map((s) => s.name), ['Gadget Qorm']);
  assert.deepEqual(frames.at(-1).sponsors[0].aliases, ['GadgetFan', 'Gadget_B'], 'every donation name the identity was seen under');
  assert.equal(sponsors.__test.state.size, 1, 'and it stacked on the replayed row');
});

test('ingest: a canonical NOT yet resolved goes out under the donation name at once, then is renamed on the next frame once the lookup answers', async () => {
  const pool = fakePool({ siteNames: { a605: 'Gadget Qorm' } });
  const frames = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: true, elapsedSec: 100 }), getStreamId: async () => null });
  sponsors.ingest({ username: 'GadgetFan', userId: 'a605', cents: 456, notionalSec: 60 });
  assert.deepEqual(frames.at(-1).sponsors.map((s) => s.name), ['GadgetFan'], 'never late: the credit goes out before the DB answers');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const last = frames.at(-1);
  assert.deepEqual(last.sponsors.map((s) => s.name), ['Gadget Qorm'], 'renamed by the follow-up frame');
  assert.deepEqual(last.sponsors[0].aliases, ['GadgetFan']);
  assert.equal(last.sponsors[0].clockRemainSec, 60, 'the badge is untouched by the rename');
  assert.equal(frames.length, 2, 'one contribution frame + one rename frame');

  // Second donation: cached — no extra frame beyond the contribution's own.
  sponsors.ingest({ username: 'GadgetFan', userId: 'a605', cents: 456, notionalSec: 60 });
  await new Promise((r) => setImmediate(r));
  assert.equal(frames.length, 3);
  assert.equal(sponsors.__test.state.size, 1);
});

test('ingest: a failed site lookup leaves the donation name standing, never throws, and is NOT cached (retried on the next contribution)', async () => {
  const pool = fakePool({ siteLookup: 'throw' });
  const frames = [];
  const origWarn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  let sponsors;
  try {
    sponsors = createSponsors({ pool, broadcast: (f) => frames.push(f), timer: fakeTimer({ active: true, elapsedSec: 0 }), getStreamId: async () => null });
    sponsors.ingest({ username: 'GadgetFan', userId: 'a605', cents: 456, notionalSec: 60 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally { console.warn = origWarn; }
  assert.deepEqual(frames.at(-1).sponsors.map((s) => s.name), ['GadgetFan']);
  assert.equal(frames.length, 1, 'no rename frame');
  assert.ok(warned.some((w) => /display-name lookup failed/.test(w)), 'the failure is logged');
  assert.equal(sponsors.__test.displayNames.has('a605'), false, 'a failure is not a "no site name" answer');
});

test('frame: aliases union across merged identities and never include the shown name itself', () => {
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer: fakeTimer({ active: false, elapsedSec: 0 }), getStreamId: async () => null });
  const state = sponsors.__test.state;
  state.set('u:1', { name: 'Gadget Qorm', aliases: new Map([['gadgetfan', 'GadgetFan']]), weightSec: 10, clockUntilElapsed: 0, clockStartElapsed: 0 });
  state.set('u:2', { name: 'gadget qorm', aliases: new Map([['gadget_b', 'Gadget_B'], ['gadget qorm', 'Gadget Qorm']]), weightSec: 5, clockUntilElapsed: 0, clockStartElapsed: 0 });
  state.set('u:3', { name: 'Dana', weightSec: 1, clockUntilElapsed: 0, clockStartElapsed: 0 }); // hand-seeded, no alias map
  const frame = sponsors.__test.buildFrame();
  assert.deepEqual(frame.sponsors.map((s) => [s.name, s.aliases]), [['Gadget Qorm', ['GadgetFan', 'Gadget_B']], ['Dana', []]]);
});

test('getOrCreate: a later-seen display name demotes the earlier one to an alias (a site rename mid-night)', () => {
  const sponsors = createSponsors({ pool: null, broadcast: () => {}, timer: fakeTimer({ active: false, elapsedSec: 0 }), getStreamId: async () => null });
  sponsors.ingest({ username: 'OldName', cents: 100, notionalSec: 1 });
  sponsors.ingest({ username: 'OldName', cents: 100, notionalSec: 1 });
  const row = sponsors.__test.state.get('n:oldname');
  assert.equal(row.name, 'OldName');
  assert.deepEqual([...row.aliases.values()], [], 'same name twice is not an alias of itself');
});

// ── clockFor: the perk's question, answered from the pool ──

test('clockFor: lit / expired / unknown, denominated in night-elapsed like the frame', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 1000 });
  const sponsors = createSponsors({ pool: fakePool(), broadcast: () => {}, timer, getStreamId: async () => 'S1' });
  sponsors.__test.state.set('u:c1', { name: 'Dana', aliases: new Map(), weightSec: 100, clockUntilElapsed: 1600, clockStartElapsed: 1000 });
  sponsors.__test.state.set('u:c2', { name: 'Eli',  aliases: new Map(), weightSec: 100, clockUntilElapsed: 900,  clockStartElapsed: 300 });
  assert.deepEqual(sponsors.clockFor(['c1']), { active: true, remainSec: 600 });
  assert.deepEqual(sponsors.clockFor(['c2']), { active: false, remainSec: 0 }, 'an expired clock is not lit');
  assert.deepEqual(sponsors.clockFor(['nobody']), { active: false, remainSec: 0 });
  assert.deepEqual(sponsors.clockFor([]), { active: false, remainSec: 0 });
  assert.deepEqual(sponsors.clockFor(null), { active: false, remainSec: 0 });
});

test('clockFor: an unmerged split — ANY live canonical lights it, remainSec is the max', () => {
  const timer = fakeTimer({ active: true, elapsedSec: 1000 });
  const sponsors = createSponsors({ pool: fakePool(), broadcast: () => {}, timer, getStreamId: async () => 'S1' });
  sponsors.__test.state.set('u:c1', { name: 'cleo', aliases: new Map(), weightSec: 100, clockUntilElapsed: 900,  clockStartElapsed: 300 });
  sponsors.__test.state.set('u:c2', { name: 'cleo', aliases: new Map(), weightSec: 100, clockUntilElapsed: 1300, clockStartElapsed: 1000 });
  sponsors.__test.state.set('u:c3', { name: 'cleo', aliases: new Map(), weightSec: 100, clockUntilElapsed: 1100, clockStartElapsed: 1000 });
  assert.deepEqual(sponsors.clockFor(['c1', 'c2', 'c3']), { active: true, remainSec: 300 });
});

test('clockFor: a paused night keeps the clock lit (the badge is visible, the perk holds)', () => {
  // elapsedSec does not tick while paused — the answer is the same on every ask.
  const timer = fakeTimer({ active: true, elapsedSec: 500 });
  const sponsors = createSponsors({ pool: fakePool(), broadcast: () => {}, timer, getStreamId: async () => 'S1' });
  sponsors.__test.state.set('u:c1', { name: 'Dana', aliases: new Map(), weightSec: 1, clockUntilElapsed: 800, clockStartElapsed: 200 });
  assert.deepEqual(sponsors.clockFor(['c1']), { active: true, remainSec: 300 });
  assert.deepEqual(sponsors.clockFor(['c1']), { active: true, remainSec: 300 });
});

// ── erase: a deleted account leaves the pool (review round 3, P8) ──

test('erase: the deleted person\'s entries leave the pool — by canonical and by every name — and the next frame says so', () => {
  const broadcasts = [];
  const sponsors = createSponsors({ pool: null, broadcast: (f) => broadcasts.push(f), timer: fakeTimer({ active: true, elapsedSec: 100 }), getStreamId: async () => null });
  sponsors.ingest({ username: 'CaseyTips', userId: 'gone1', cents: 500, notionalSec: 60 });
  sponsors.ingest({ username: 'Casey', cents: 100, notionalSec: 10 }); // a payload with no canonical: keyed by name
  sponsors.ingest({ username: 'Dana', userId: 'stay1', cents: 300, notionalSec: 30 });
  sponsors.__test.displayNames.set('gone1', 'Casey Site');
  entryOf(sponsors.__test.state, 'gone1').aliases.set('caseyold', 'CaseyOld');
  const out = sponsors.erase({ canonicalIds: ['gone1'], names: ['Casey', 'CaseyTips'] });
  assert.equal(out, 2);
  assert.deepEqual(poolIds(sponsors.__test.state), ['u:stay1'], 'someone else left the pool, or the deleted person stayed in it');
  assert.equal(sponsors.__test.displayNames.has('gone1'), false, 'their site name stayed cached');
  const frame = broadcasts.at(-1);
  const wire = JSON.stringify(frame);
  for (const n of ['Casey', 'CaseyTips', 'CaseyOld']) assert.ok(!wire.includes(n), `${n} is still on the public frame: ${wire}`);
  assert.deepEqual(frame.sponsors.map((s) => s.name), ['Dana']);
  assert.equal(sponsors.erase({ canonicalIds: [], names: [] }), 0);
});

test('replay: a payment whose person was deleted (named "(deleted)") is never credited after a restart', async () => {
  const events = {
    real: [
      { user_id: '(erased)', username: '(deleted)', amount_usd: '9.00', created_at: new Date('2026-08-22T04:00:00Z') },
      { user_id: 'c2', username: 'Kofi_Kim', amount_usd: '3.00', created_at: new Date('2026-08-22T05:00:00Z') },
    ],
  };
  const pool = fakePool({
    timerRow: noNightRow,
    sessions: [{ stream_id: 'real', started_at: new Date('2026-08-22T03:49:00Z'), ended_at: new Date('2026-08-22T12:31:00Z') }],
    events,
  });
  const broadcasts = [];
  const sponsors = createSponsors({ pool, broadcast: (f) => broadcasts.push(f), timer: fakeTimer({ active: false, elapsedSec: 0, usdPerHour: 40 }), getStreamId: async () => null });
  await sponsors.init();
  assert.deepEqual(broadcasts.at(-1).sponsors.map((s) => s.name), ['Kofi_Kim'], 'a deleted person\'s payment came back as a credit');
});
