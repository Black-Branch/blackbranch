// Against a REAL Postgres (v159): a credit whose
// refunds were HELD before it landed moves the support bar and the timer by its NET only — fully
// refunded → nothing, partly refunded → the kept part. A refund that arrives AFTER the credit
// granted its time still takes nothing back. The admitted amount is PERSISTED on the
// ledger row (stream.support_events.admitted_usd) so the bar's restart rebuild agrees with what
// the live path showed — a live-only fix would revert at the next restart, because the rebuild
// sums the credit rows of the stream and a reversal row carries no stream_id.
//
// Every fix here passes its original failure path, a restart (a fresh bar rebuilt from the
// ledger) and a retry (the same delivery again, and a write whose first COMMIT is lost).
//
// Fixtures are scoped to ids containing `g6test` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test support-held-net-bar.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createAlert } = require('./alert');
const { createSupportBar } = require('./supportbar');
const { createMoney, makeRecordSupport, makeRecordUnpriced } = require('./money');
const economics = require('./economics');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const SESSION = 'g6test-session';
const DONOR = '@g6test-casey:site.test';

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

test('a credit with held refunds moves the bar and timer by its net, live and after a restart', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 12 });
  const clean = () => serially(pool, async () => {
    const users = (await pool.query(
      `SELECT DISTINCT user_id FROM stream.support_events WHERE event_id LIKE '%g6test%'`)).rows.map((r) => r.user_id);
    await pool.query(`DELETE FROM stream.support_events WHERE reverses_id IN (SELECT id FROM stream.support_events WHERE event_id LIKE '%g6test%')`);
    await pool.query(`DELETE FROM stream.support_events WHERE event_id LIKE '%g6test%'`);
    await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE '%g6test%'`);
    await pool.query(`DELETE FROM stream.support_reversal_holds WHERE event_id LIKE '%g6test%'`);
    const linked = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE '%g6test%'`)).rows.map((r) => r.canonical);
    const all = [...new Set([...users, ...linked])];
    if (all.length) {
      await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [all]);
    }
    await pool.query(`DELETE FROM stream.sessions WHERE stream_id = $1`, [SESSION]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO stream.sessions (stream_id, started_at) VALUES ($1, NOW() - interval '1 hour')`, [SESSION]);
  const liveState = async () => ({ live: true, streamId: SESSION });
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });

  // A pool whose next N COMMITs are LOST: the transaction is rolled back and the caller sees a
  // transient connection error — the shape of a write that never landed and is retried.
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
  const recordSupport = makeRecordSupport({ pool: flaky, resolveOrCreate: identity.resolveOrCreate, liveState });
  const recordUnpriced = makeRecordUnpriced({ pool, liveState });

  const frames = [];
  const earned = []; // every dollar amount the timer was asked to turn into time
  const flashed = []; // every dollar amount the room lights were flashed for
  const published = []; // every money-bus payload (meter, sponsor pool) — cents
  const bar = createSupportBar({
    pool, broadcast: (f) => frames.push(f), getStreamId: async () => SESSION,
    earnTime: (usd) => { earned.push(usd); return Math.round(usd * 60); },
    onAdd: (p) => published.push(p.cents),
  });
  await quietly(() => bar.init());
  const alert = createAlert({
    broadcast: (f) => frames.push(f), bufferPush: () => {}, obs: null, tts: null,
    lights: { flash: async (_kind, { usd }) => { flashed.push(usd); } },
    supportBar: bar, logSupport: recordSupport, logUnpriced: recordUnpriced, persistCard: async () => null,
    ledgerRetryMs: [1], ledgerSlowMs: 60_000, sleep: async () => {},
  });
  const money = createMoney({ pool, economics, alert, recordSupport, broadcast: (f) => frames.push(f), bufferPush: () => {},
    persistEventCard: async () => null, sponsors: { reset: async () => {} } });
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
  const refund = (spend, ref, extra = {}) => call('/support/reverse', { kind: 'donation', spendId: `donation:${spend}`, ref, reason: 'refund', ...extra });
  const deliver = (spend, usd = 10) => quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation',
    username: 'casey', userId: DONOR, takeHomeUSD: usd, eventId: `donation:donation:${spend}` }));
  const admitted = async (spend) => {
    const row = (await pool.query(`SELECT admitted_usd FROM stream.support_events WHERE event_id = $1 AND reverses_id IS NULL`, [keyOf(spend)])).rows[0];
    assert.ok(row, `no credit row for ${spend}`);
    return row.admitted_usd == null ? null : Number(row.admitted_usd);
  };
  /** A process restart: a NEW bar, rebuilt from the ledger alone. */
  const rebuilt = async () => {
    const fresh = createSupportBar({ pool, broadcast: () => {}, getStreamId: async () => SESSION, earnTime: () => 0 });
    return quietly(() => fresh.init());
  };
  const barFrames = () => frames.filter((f) => f.type === 'updateSupportBar');
  const reset = () => { frames.length = 0; earned.length = 0; flashed.length = 0; published.length = 0; };
  /** Restart proof: what a fresh process rebuilds from the ledger equals what ran live. */
  const assertRestartAgrees = async (why) => assert.equal(await rebuilt(), bar.getTotal(), `restart: the rebuilt bar disagrees with the live bar — ${why}`);

  await t.test('original path: a credit whose held refund covers it WHOLE moves neither the bar nor the timer', async () => {
    assert.equal((await refund('g6test-full', 'stripe:refund:g6test-rfull')).statusCode, 202);
    reset();
    const before = bar.getTotal();
    const out = await deliver('g6test-full');
    assert.equal(out.refunded, true);
    assert.equal(bar.getTotal(), before, 'a fully refunded credit moved the bar');
    assert.deepEqual(earned, [], 'a fully refunded credit bought time');
    assert.equal(barFrames().length, 0, 'a fully refunded credit broadcast a bar move');
    assert.equal(out.addedSeconds, 0);
    assert.equal(out.marathonEnded, false, 'a refunded credit is not a "the marathon is over" contribution');
    assert.deepEqual(published, [], 'a fully refunded credit reached the meter / sponsor pool');
    assert.equal(await admitted('g6test-full'), 0, 'the admitted amount must be PERSISTED so the rebuild agrees');
    await assertRestartAgrees('full cover');
  });

  await t.test('original path: a credit with a held PARTIAL refund moves the bar and timer by the kept part', async () => {
    assert.equal((await refund('g6test-part', 'stripe:refund:g6test-rpart', { refunded: 250, gross: 1000 })).statusCode, 202);
    reset();
    const before = bar.getTotal();
    const out = await deliver('g6test-part');
    assert.ok(!out.refunded);
    assert.equal(bar.getTotal(), Math.round((before + 7.5) * 100) / 100, 'the bar must move by the net, not the gross take-home');
    assert.deepEqual(earned, [7.5], 'the timer must be credited the net');
    assert.equal(out.addedSeconds, 450);
    assert.deepEqual(flashed, [7.5], 'the lights must flash for the same net the bar moved');
    assert.deepEqual(published, [750], 'the meter / sponsor pool must get the same net');
    assert.equal(await admitted('g6test-part'), 7.5);
    await assertRestartAgrees('partial cover');
  });

  await t.test('original path: several held PARTIAL refunds — the bar and timer move by what is left after all of them', async () => {
    assert.equal((await refund('g6test-multi', 'stripe:refund:g6test-rm1', { refunded: 200, gross: 1000 })).statusCode, 202);
    assert.equal((await refund('g6test-multi', 'stripe:refund:g6test-rm2', { refunded: 300, gross: 1000 })).statusCode, 202);
    reset();
    const before = bar.getTotal();
    const out = await deliver('g6test-multi', 12);
    assert.ok(!out.refunded);
    // 12 − 12×0.2 − 12×0.3 = 6
    assert.equal(bar.getTotal(), Math.round((before + 6) * 100) / 100);
    assert.deepEqual(earned, [6]);
    assert.equal(await admitted('g6test-multi'), 6);
    await assertRestartAgrees('multiple partial holds');
  });

  await t.test('original path, unchanged: a credit with nothing held moves the bar by its whole amount and stores no override', async () => {
    reset();
    const before = bar.getTotal();
    await deliver('g6test-plain', 4);
    assert.equal(bar.getTotal(), Math.round((before + 4) * 100) / 100);
    assert.deepEqual(earned, [4]);
    assert.equal(await admitted('g6test-plain'), null, 'an ordinary credit counts its own amount — no override column written');
    await assertRestartAgrees('no holds');
  });

  await t.test('unchanged: a refund that arrives AFTER the credit granted its time takes nothing back, live or rebuilt', async () => {
    reset();
    const before = bar.getTotal();
    await deliver('g6test-after', 6);
    assert.equal(bar.getTotal(), Math.round((before + 6) * 100) / 100);
    const r = await refund('g6test-after', 'stripe:refund:g6test-rafter');
    assert.equal(r.statusCode, 200);
    assert.equal(bar.getTotal(), Math.round((before + 6) * 100) / 100, 'a later refund moved the live bar');
    assert.equal(await admitted('g6test-after'), null, 'a later refund must not rewrite the admitted amount');
    await assertRestartAgrees('a post-grant refund');
  });

  await t.test('race: a refund racing the first delivery — whichever lands first, live and rebuilt agree and the ledger nets 0', async () => {
    for (let i = 0; i < 12; i++) {
      const spend = `g6test-race${i}`;
      const before = bar.getTotal();
      const ref = `stripe:refund:g6test-rr${i}`;
      const answers = await Promise.all(i % 2 ? [refund(spend, ref), deliver(spend, 5)] : [deliver(spend, 5), refund(spend, ref)]);
      const r = answers.find((x) => x && 'statusCode' in x);
      assert.ok(r.statusCode < 300, `race ${i}: the refund answered ${r.statusCode}`);
      const net = Number((await pool.query(
        `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM stream.support_events
          WHERE event_id = $1 OR reverses_id IN (SELECT id FROM stream.support_events WHERE event_id = $1)`, [keyOf(spend)])).rows[0].s);
      assert.equal(net, 0, `race ${i}: the ledger did not net exactly once`);
      const adm = await admitted(spend);
      // Refund first → held → nothing admitted. Credit first → time granted; the later refund takes nothing back.
      const moved = Math.round((bar.getTotal() - before) * 100) / 100;
      assert.ok((adm === 0 && moved === 0) || (adm === null && moved === 5), `race ${i}: admitted=${adm} moved=${moved}`);
      await assertRestartAgrees(`race ${i}`);
    }
  });

  await t.test('restart: a bar rebuilt from the ledger equals the live bar across every case above', async () => {
    // Live: full 0 + partial 7.5 + multi 6 + plain 4 + after 6 = 23.5, plus 5 per race the credit won.
    const raceWins = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM stream.support_events WHERE event_id LIKE '%g6test-race%' AND reverses_id IS NULL AND admitted_usd IS NULL`)).rows[0].n);
    assert.equal(bar.getTotal(), Math.round((23.5 + 5 * raceWins) * 100) / 100);
    await assertRestartAgrees('every case together');
  });

  await t.test('retry: the same delivery again is a duplicate — the bar and the timer do not move twice', async () => {
    reset();
    const before = bar.getTotal();
    for (const spend of ['g6test-full', 'g6test-part', 'g6test-multi', 'g6test-plain']) {
      const out = await deliver(spend);
      assert.equal(out.duplicate, true, `${spend}: a redelivery was not answered "already recorded"`);
    }
    assert.equal(bar.getTotal(), before);
    assert.deepEqual(earned, []);
    assert.equal(await admitted('g6test-part'), 7.5, 'a redelivery rewrote the admitted amount');
    assert.equal(await rebuilt(), bar.getTotal());
  });

  await t.test('retry: a write whose first COMMIT is lost is retried and moves the bar by the net exactly once', async () => {
    assert.equal((await refund('g6test-lost', 'stripe:refund:g6test-rlost', { refunded: 500, gross: 1000 })).statusCode, 202);
    reset();
    const before = bar.getTotal();
    commitsToLose = 1;
    const out = await deliver('g6test-lost', 8);
    assert.equal(commitsToLose, 0, 'the lost COMMIT was never exercised — the retry path was not tested');
    assert.ok(!out.refunded && !out.duplicate, JSON.stringify(out));
    assert.equal(bar.getTotal(), Math.round((before + 4) * 100) / 100, 'the retried credit must move the bar by its net once');
    assert.deepEqual(earned, [4]);
    assert.equal(await admitted('g6test-lost'), 4);
    const rev = (await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_usd), 0) AS s FROM stream.support_events
        WHERE reverses_id = (SELECT id FROM stream.support_events WHERE event_id = $1)`, [keyOf('g6test-lost')])).rows[0];
    assert.deepEqual({ n: rev.n, s: Number(rev.s) }, { n: 1, s: -4 }, 'the retry must not apply the held reversal twice');
    const hold = (await pool.query(`SELECT status FROM stream.support_reversal_holds WHERE event_id = $1`, [keyOf('g6test-lost')])).rows[0];
    assert.equal(hold.status, 'applied');
    assert.equal(await rebuilt(), bar.getTotal(), 'restart after a retried write: the rebuild disagrees');
  });

  await t.test('reconcile: a ledger_failed credit fully refunded while it waited adds nothing to its stream\'s rebuilt bar', async () => {
    await recordUnpriced({ platform: 'native', eventType: 'donation', userId: DONOR, username: 'casey', amountNative: 10,
      currency: 'USD', raw: 'ledger write failed (08006)', eventId: keyOf('g6test-rec'), reason: 'ledger_failed' });
    const id = Number((await pool.query(`SELECT id FROM stream.unpriced_support WHERE event_id = $1`, [keyOf('g6test-rec')])).rows[0].id);
    assert.equal((await refund('g6test-rec', 'stripe:refund:g6test-rrec')).statusCode, 202);
    const before = await rebuilt();
    const rec = await call('/support/reconcile', { id, amountUsd: 10 });
    assert.equal(rec.body.credited, true);
    assert.equal(await admitted('g6test-rec'), 0);
    assert.equal(await rebuilt(), before, 'a fully refunded reconciled credit appeared on the rebuilt bar');
  });
});
