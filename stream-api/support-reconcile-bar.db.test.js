// Round 7 (k, after round 6) against a REAL Postgres (v159): POST /support/reconcile credits an
// unpriced payment under its OWN stream. When that stream is the one live right now, the live bar
// and the timer move by the credit's ADMITTED amount (the net of any refunds held for it) — the
// same supportBar.add alert.js calls, so the money bus (sponsor pool, meter) sees it once. Before
// this, nothing moved live, but the bar's restart rebuild sums every credit row of the stream —
// so the bar jumped by that amount at the next restart.
//
// Every case passes its original path, a RESTART (a fresh bar rebuilt from the ledger equals the
// live bar) and a RETRY (the same reconcile twice, and one whose COMMIT is lost, move it once).
//
// Fixtures are scoped to ids containing `r7rbtest` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test support-reconcile-bar.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createSupportBar } = require('./supportbar');
const { createSponsors } = require('./sponsors');
const { createMoneyBus, subscribeSponsors } = require('./money-bus');
const { createMoney, makeRecordSupport, makeRecordUnpriced } = require('./money');
const economics = require('./economics');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const LIVE = 'r7rbtest-live';
const PAST = 'r7rbtest-past';
const DONOR = '@r7rbtest-casey:site.test';

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};
/** Run `fn` keeping every console.log line it writes. */
const logged = async (fn) => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => lines.push(require('node:util').format(...a));
  console.warn = () => {}; console.error = (...a) => lines.push(require('node:util').format(...a));
  try { return { out: await fn(), lines }; } finally { Object.assign(console, saved); }
};
const r2 = (n) => Math.round(n * 100) / 100;

test('a reconcile during a live stream moves the live bar, the timer and the pool once — live, restarted and retried', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 12 });
  const clean = () => serially(pool, async () => {
    const users = (await pool.query(
      `SELECT DISTINCT user_id FROM stream.support_events WHERE event_id LIKE '%r7rbtest%'`)).rows.map((r) => r.user_id);
    await pool.query(`DELETE FROM stream.support_events WHERE reverses_id IN (SELECT id FROM stream.support_events WHERE event_id LIKE '%r7rbtest%')`);
    await pool.query(`DELETE FROM stream.support_events WHERE event_id LIKE '%r7rbtest%'`);
    await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE '%r7rbtest%'`);
    await pool.query(`DELETE FROM stream.support_reversal_holds WHERE event_id LIKE '%r7rbtest%'`);
    const linked = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE '%r7rbtest%'`)).rows.map((r) => r.canonical);
    const all = [...new Set([...users, ...linked])];
    if (all.length) {
      await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [all]);
    }
    await pool.query(`DELETE FROM stream.sessions WHERE stream_id = ANY($1)`, [[LIVE, PAST]]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO stream.sessions (stream_id, started_at) VALUES ($1, NOW() - interval '1 day'), ($2, NOW() - interval '1 hour')`, [PAST, LIVE]);
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  let live = LIVE; // the stream the process thinks is live right now
  const liveState = async () => ({ live: !!live, streamId: live });

  // A pool whose next N COMMITs are LOST: rolled back, and the caller sees a transient error.
  let commitsToLose = 0;
  const flaky = {
    query: (...a) => pool.query(...a),
    connect: async () => {
      const c = await pool.connect();
      const real = c.query.bind(c);
      return {
        query: async (sql, ...rest) => {
          if (sql === 'COMMIT' && commitsToLose > 0) {
            commitsToLose--;
            await real('ROLLBACK');
            throw Object.assign(new Error('connection terminated (test)'), { code: '08006' });
          }
          return real(sql, ...rest);
        },
        release: (...a) => c.release(...a),
      };
    },
  };
  const recordSupport = makeRecordSupport({ pool, resolveOrCreate: identity.resolveOrCreate, liveState });

  // The sponsor pool, fed through the money bus exactly as index.js wires it. No night: a dollar
  // is worth 100 notional seconds at $36/h, live (earnTime below) and replayed alike.
  // `parkRebuild`: the next sponsor rebuild stops AFTER it has read tonight's ledger (at its
  // previous-session lookup) until released — so a live credit lands while it is mid-flight.
  let parkRebuild = null;
  const sponsorDb = {
    query: async (sql, ...rest) => {
      if (parkRebuild && /ended_at IS NOT NULL/.test(sql)) { const p = parkRebuild; parkRebuild = null; p.reached(); await p.released; }
      return pool.query(sql, ...rest);
    },
  };
  const sponsors = createSponsors({
    pool: sponsorDb, broadcast: () => {}, getStreamId: async () => live,
    timer: { snapshot: () => ({ night: { active: false, elapsedSec: 0 }, usdPerHour: 36 }) },
  });
  const bus = createMoneyBus();
  subscribeSponsors(bus, sponsors);
  let lastRebuild = Promise.resolve();
  let skipRouteRebuild = false; // the route's own rebuild trigger, swallowed once (see the ledger-id case)
  const sponsorsSeam = { reset: () => { if (skipRouteRebuild) { skipRouteRebuild = false; return Promise.resolve(); } return (lastRebuild = sponsors.reset()); } };

  const earned = []; // every dollar amount the timer was asked to turn into time
  const published = []; // every money-bus payload, in cents
  let barBroken = false;
  const realBar = createSupportBar({
    pool, broadcast: () => {}, getStreamId: async () => live,
    earnTime: (usd) => { earned.push(usd); return Math.round(usd * 100); },
    onAdd: (p) => { published.push(p.cents); bus.publish(p); },
  });
  await quietly(() => realBar.init());
  await quietly(() => sponsors.init());
  const bar = {
    ...realBar,
    add: (...a) => { if (barBroken) throw new Error('bar down (test)'); return realBar.add(...a); },
  };

  let beforeLiveRead = null; // runs after the reconcile's COMMIT, before the live bar moves
  const money = createMoney({ pool: flaky, economics, alert: null, supportBar: bar, recordSupport,
    getStreamId: async () => { if (beforeLiveRead) await beforeLiveRead(); return (await liveState()).streamId || null; },
    broadcast: () => {}, bufferPush: () => {}, persistEventCard: async () => null, sponsors: sponsorsSeam });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
    { requireInternal: (_q, _s, n) => n(), requireSecret: (_q, _s, n) => n(), wrap: (fn) => fn });
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await quietly(() => routes[path]({ body }, res));
    return res;
  };

  const keyOf = (spend) => `alert:native:donation:donation:${spend}`;
  /** An unpriced (ledger_failed) row recorded while `streamId` was live. */
  const unpriced = async (spend, streamId, usd = 10) => {
    const rec = makeRecordUnpriced({ pool, liveState: async () => ({ streamId }) });
    await rec({ platform: 'native', eventType: 'donation', userId: DONOR, username: 'casey', amountNative: usd,
      currency: 'USD', raw: 'ledger write failed (08006)', eventId: keyOf(spend), reason: 'ledger_failed' });
    return Number((await pool.query(`SELECT id FROM stream.unpriced_support WHERE event_id = $1`, [keyOf(spend)])).rows[0].id);
  };
  const refund = (spend, ref, extra = {}) => call('/support/reverse', { kind: 'donation', spendId: `donation:${spend}`, ref, reason: 'refund', ...extra });
  /** A process restart: a NEW bar, rebuilt from the ledger alone, for `streamId`. */
  const rebuilt = async (streamId = LIVE) => {
    const fresh = createSupportBar({ pool, broadcast: () => {}, getStreamId: async () => streamId, earnTime: () => 0 });
    return quietly(() => fresh.init());
  };
  const assertRestartAgrees = async (why) => assert.equal(await rebuilt(), realBar.getTotal(), `restart: the rebuilt bar disagrees with the live bar — ${why}`);
  const reset = () => { earned.length = 0; published.length = 0; };
  const poolWeight = () => [...sponsors.__test.state.values()].reduce((s, e) => s + e.weightSec, 0);

  await t.test('original path: a reconcile for the LIVE stream moves the bar and the timer by its amount; restart agrees', async () => {
    const id = await unpriced('r7rbtest-a', LIVE);
    reset();
    const before = realBar.getTotal();
    const { out: res, lines } = await logged(async () => {
      const r = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/support/reconcile']({ body: { id, amountUsd: 10 } }, r);
      return r;
    });
    assert.equal(res.body.credited, true);
    assert.equal(realBar.getTotal(), r2(before + 10), 'the live bar did not move by the reconciled amount');
    assert.deepEqual(earned, [10], 'the timer was not credited the reconciled amount');
    assert.deepEqual(published, [1000], 'the money bus must see the credit exactly once');
    const line = lines.find((l) => l.includes('RECONCILED'));
    assert.ok(line && /live bar \+\$10\.00/.test(line), `the journal must say the live bar moved and by how much: ${line}`);
    assert.ok(!line.includes('casey'), 'the journal names the person');
    await assertRestartAgrees('a live reconcile');
  });

  await t.test('original path: a held PARTIAL refund — the live bar and timer move by the net; restart agrees', async () => {
    const id = await unpriced('r7rbtest-b', LIVE);
    assert.equal((await refund('r7rbtest-b', 'stripe:refund:r7rbtest-rb', { refunded: 400, gross: 1000 })).statusCode, 202);
    reset();
    const before = realBar.getTotal();
    const res = await call('/support/reconcile', { id, amountUsd: 10 });
    assert.equal(res.body.credited, true);
    assert.equal(realBar.getTotal(), r2(before + 6), 'the live bar must move by the net of the held refund');
    assert.deepEqual(earned, [6]);
    assert.deepEqual(published, [600]);
    await assertRestartAgrees('a partly refunded live reconcile');
  });

  await t.test('original path: a held FULL refund — nothing moves live; restart agrees', async () => {
    const id = await unpriced('r7rbtest-c', LIVE);
    assert.equal((await refund('r7rbtest-c', 'stripe:refund:r7rbtest-rc')).statusCode, 202);
    reset();
    const before = realBar.getTotal();
    const res = await call('/support/reconcile', { id, amountUsd: 10 });
    assert.equal(res.body.credited, true);
    assert.equal(realBar.getTotal(), before);
    assert.deepEqual(earned, []);
    assert.deepEqual(published, []);
    await assertRestartAgrees('a fully refunded live reconcile');
  });

  await t.test('original path: a reconcile for a PAST stream moves nothing live; that stream\'s rebuild counts it', async () => {
    const id = await unpriced('r7rbtest-d', PAST, 7);
    reset();
    const before = realBar.getTotal();
    const pastBefore = await rebuilt(PAST);
    const { out: res, lines } = await logged(async () => {
      const r = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/support/reconcile']({ body: { id, amountUsd: 7 } }, r);
      return r;
    });
    assert.equal(res.body.credited, true);
    assert.equal(realBar.getTotal(), before, 'a past stream\'s reconcile moved the live bar');
    assert.deepEqual(earned, []);
    assert.deepEqual(published, []);
    assert.equal(await rebuilt(PAST), r2(pastBefore + 7), 'the past stream\'s history must count the credit');
    const line = lines.find((l) => l.includes('RECONCILED'));
    assert.ok(line && /live bar unmoved/.test(line), `the journal must say the live bar did not move: ${line}`);
    await assertRestartAgrees('a past-stream reconcile');
  });

  await t.test('original path: a reconcile with NO stream (recorded off-air) moves nothing live', async () => {
    const id = await unpriced('r7rbtest-e', null, 3);
    reset();
    const before = realBar.getTotal();
    const res = await call('/support/reconcile', { id, amountUsd: 3 });
    assert.equal(res.body.credited, true);
    assert.equal(realBar.getTotal(), before);
    assert.deepEqual(earned, []);
    await assertRestartAgrees('an off-air reconcile');
  });

  await t.test('original path: off-air NOW — a reconcile for the stream that WAS live moves nothing live', async () => {
    const id = await unpriced('r7rbtest-f', LIVE, 2);
    reset();
    live = null;
    try {
      const before = realBar.getTotal();
      const res = await call('/support/reconcile', { id, amountUsd: 2 });
      assert.equal(res.body.credited, true);
      assert.equal(realBar.getTotal(), before);
      assert.deepEqual(earned, []);
    } finally { live = LIVE; }
    // The bar of LIVE did not see it, but its rebuild does: put the bar back in step for the cases below.
    await quietly(() => realBar.init());
  });

  await t.test('original path: a dismiss moves nothing', async () => {
    const id = await unpriced('r7rbtest-g', LIVE);
    reset();
    const before = realBar.getTotal();
    const res = await call('/support/reconcile', { id, dismiss: true });
    assert.equal(res.body.status, 'dismissed');
    assert.equal(realBar.getTotal(), before);
    assert.deepEqual(earned, []);
    assert.deepEqual(published, []);
    await assertRestartAgrees('a dismiss');
  });

  await t.test('original path: a reconcile of an event the ledger already holds (duplicate) moves nothing', async () => {
    const id = await unpriced('r7rbtest-h', LIVE, 5);
    // The same event's late delivery landed first (alert.js's path — its own bar move is not this route's).
    await recordSupport({ platform: 'native', userId: DONOR, username: 'casey', amountUsd: 5, eventType: 'donation',
      eventId: keyOf('r7rbtest-h'), streamId: LIVE });
    await quietly(() => realBar.init()); // the bar as alert.js would have left it
    reset();
    const before = realBar.getTotal();
    const res = await call('/support/reconcile', { id, amountUsd: 5 });
    assert.equal(res.body.status, 'reconciled');
    assert.notEqual(res.body.credited, true, JSON.stringify(res.body));
    assert.equal(realBar.getTotal(), before, 'a duplicate reconcile moved the live bar');
    assert.deepEqual(earned, []);
    await assertRestartAgrees('a duplicate reconcile');
  });

  await t.test('retry: the same reconcile twice — the second answers deduped and the bar moved once; restart agrees', async () => {
    const id = await unpriced('r7rbtest-i', LIVE, 4);
    reset();
    const before = realBar.getTotal();
    const first = await call('/support/reconcile', { id, amountUsd: 4 });
    const second = await call('/support/reconcile', { id, amountUsd: 4 });
    assert.equal(first.body.credited, true);
    assert.equal(second.body.deduped, true);
    assert.equal(realBar.getTotal(), r2(before + 4), 'the retry moved the bar a second time');
    assert.deepEqual(earned, [4]);
    assert.deepEqual(published, [400]);
    await assertRestartAgrees('a retried reconcile');
  });

  await t.test('retry: a reconcile whose COMMIT is lost moves nothing; its retry moves the bar once; restart agrees', async () => {
    const id = await unpriced('r7rbtest-j', LIVE, 9);
    reset();
    const before = realBar.getTotal();
    commitsToLose = 1;
    await assert.rejects(quietly(() => routes['/support/reconcile']({ body: { id, amountUsd: 9 } },
      { status() { return this; }, json() { return this; } })), /connection terminated/);
    assert.equal(commitsToLose, 0, 'the lost COMMIT was never exercised');
    assert.equal(realBar.getTotal(), before, 'a reconcile whose COMMIT was lost moved the live bar');
    assert.deepEqual(earned, []);
    const again = await call('/support/reconcile', { id, amountUsd: 9 });
    assert.equal(again.body.credited, true);
    assert.equal(realBar.getTotal(), r2(before + 9));
    assert.deepEqual(earned, [9]);
    await assertRestartAgrees('a reconcile retried after a lost COMMIT');
  });

  await t.test('a bar that fails AFTER the COMMIT does not unwind the credit; restart catches the bar up', async () => {
    const id = await unpriced('r7rbtest-k', LIVE, 3);
    reset();
    barBroken = true;
    let res;
    try { res = await call('/support/reconcile', { id, amountUsd: 3 }); } finally { barBroken = false; }
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.credited, true);
    const row = (await pool.query(`SELECT amount_usd FROM stream.support_events WHERE event_id = $1`, [keyOf('r7rbtest-k')])).rows[0];
    assert.equal(Number(row.amount_usd), 3, 'the ledger row must stand when the bar fails');
    assert.equal(await rebuilt(), r2(realBar.getTotal() + 3), 'the restart must count the credit the live bar missed');
    await quietly(() => realBar.init());
  });

  await t.test('sponsor pool: a live reconcile is counted ONCE after the route\'s own rebuild', async () => {
    const id = await unpriced('r7rbtest-s1', LIVE, 5);
    await quietly(() => sponsors.init());
    const before = poolWeight();
    const res = await call('/support/reconcile', { id, amountUsd: 5 });
    assert.equal(res.body.credited, true);
    assert.equal(poolWeight(), before + 500, 'the live credit did not reach the pool once through the money bus');
    await quietly(() => lastRebuild);
    assert.equal(poolWeight(), before + 500, 'the route\'s rebuild did not leave the credit counted exactly once');
    await quietly(() => sponsors.init());
    assert.equal(poolWeight(), before + 500, 'restart: the rebuilt pool disagrees');
  });

  // The route's own rebuild would re-run any in-flight one (sponsors.init coalesces) and so mask
  // the journal's ledger-id dedupe; it is swallowed here so the swap of the in-flight rebuild —
  // which another trigger (a night start, a links change) may have started — is what is measured.
  await t.test('sponsor pool: a rebuild that READ the credit\'s row before the live credit landed counts it ONCE (ledger id)', async () => {
    const id = await unpriced('r7rbtest-s2', LIVE, 8);
    await quietly(() => sponsors.init());
    const before = poolWeight();
    let inflight = null;
    // After the COMMIT, before the bar moves: a rebuild reads tonight's ledger (the new row with it)
    // and is held before its swap; the live credit then lands mid-rebuild and is journaled.
    beforeLiveRead = async () => {
      beforeLiveRead = null;
      let reached; let release;
      const atPark = new Promise((r) => { reached = r; });
      parkRebuild = { reached, released: new Promise((r) => { release = r; }) };
      inflight = { done: quietly(() => sponsors.init()), release };
      await atPark;
    };
    skipRouteRebuild = true;
    const res = await call('/support/reconcile', { id, amountUsd: 8 });
    assert.equal(res.body.credited, true);
    assert.equal(skipRouteRebuild, false, 'the route did not ask for its rebuild');
    assert.ok(inflight, 'the mid-flight rebuild was never started — the case was not exercised');
    inflight.release();
    await inflight.done;
    await quietly(() => lastRebuild);
    assert.equal(poolWeight(), before + 800, 'a credit the rebuild had already read was counted again from its journal');
    await quietly(() => sponsors.init());
    assert.equal(poolWeight(), before + 800, 'restart: the rebuilt pool disagrees');
  });

  await t.test('restart: the bar rebuilt from the ledger equals the live bar across every case above', async () => {
    await assertRestartAgrees('every case together');
  });
});
