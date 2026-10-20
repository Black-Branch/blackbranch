// PB2 (review round 5) against a REAL Postgres (v156): a refund or dispute of a native payment
// the support ledger does not hold YET is held (stream.support_reversal_holds), and the credit
// takes it back in the same transaction when it lands — through POST /support/reconcile (a
// ledger_failed / unpriced row) or through a late delivery of the event itself. Before v156 the
// route answered 404 `unknown_event`, web logged "nothing reversed" and answered the provider 200,
// and a later reconcile credited the refunded payment in full.
//
// Fixtures are scoped to ids containing `g5test` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test support-reversal-holds.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createAlert } = require('./alert');
const { createMoney, makeRecordSupport, makeRecordUnpriced } = require('./money');
const economics = require('./economics');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const SESSION = 'g5test-session';
const DONOR = '@g5test-casey:site.test';

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

test('reversals that arrive before their credit, against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL, max: 12 });
  const clean = () => serially(pool, async () => {
    const users = (await pool.query(
      `SELECT DISTINCT user_id FROM stream.support_events WHERE event_id LIKE '%g5test%'`)).rows.map((r) => r.user_id);
    await pool.query(`DELETE FROM stream.support_events WHERE reverses_id IN (SELECT id FROM stream.support_events WHERE event_id LIKE '%g5test%')`);
    await pool.query(`DELETE FROM stream.support_events WHERE event_id LIKE '%g5test%'`);
    await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE '%g5test%'`);
    await pool.query(`DELETE FROM stream.support_reversal_holds WHERE event_id LIKE '%g5test%'`);
    const linked = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE '%g5test%'`)).rows.map((r) => r.canonical);
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
  let reversedCalls = 0;
  const recordSupport = makeRecordSupport({ pool, resolveOrCreate: identity.resolveOrCreate, liveState, onReversed: () => { reversedCalls++; } });
  const recordUnpriced = makeRecordUnpriced({ pool, liveState });
  const frames = [];
  const barAdds = [];
  const alert = createAlert({
    broadcast: (f) => frames.push(f), bufferPush: () => {}, obs: null, tts: null, lights: null,
    supportBar: { add: (usd) => { barAdds.push(usd); return { deltaSeconds: 0 }; } },
    logSupport: recordSupport, logUnpriced: recordUnpriced, persistCard: async () => null,
  });
  let sponsorResets = 0;
  const money = createMoney({ pool, economics, alert, recordSupport, broadcast: (f) => frames.push(f), bufferPush: () => {},
    persistEventCard: async () => null,
    sponsors: { reset: async () => { sponsorResets++; } } });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
    { requireInternal: (_q, _s, n) => n(), requireSecret: (_q, _s, n) => n(), wrap: (fn) => fn });
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await quietly(() => routes[path]({ body }, res));
    return res;
  };

  // A native donation whose ledger write failed: alert.js recordFailure keeps it as an open
  // 'ledger_failed' row, amount = the take-home in USD, under the key the credit would have used.
  const keyOf = (spend) => `alert:native:donation:donation:${spend}`;
  const failedDonation = async (spend, usd = 10) => {
    await recordUnpriced({ platform: 'native', eventType: 'donation', userId: DONOR, username: 'casey', amountNative: usd,
      currency: 'USD', raw: 'ledger write failed (08006)', eventId: keyOf(spend), reason: 'ledger_failed' });
    return Number((await pool.query(`SELECT id FROM stream.unpriced_support WHERE event_id = $1`, [keyOf(spend)])).rows[0].id);
  };
  const refund = (spend, ref, extra = {}) => call('/support/reverse', { kind: 'donation', spendId: `donation:${spend}`, ref, reason: 'refund', ...extra });
  /** What the ledger holds for one payment: its credit plus every reversal of it. */
  const net = async (spend) => {
    const r = await pool.query(
      `SELECT COALESCE(SUM(e.amount_usd), 0) AS s, COUNT(*) FILTER (WHERE e.reverses_id IS NOT NULL) AS reversals
         FROM stream.support_events e
        WHERE e.event_id = $1 OR e.reverses_id IN (SELECT id FROM stream.support_events WHERE event_id = $1)`, [keyOf(spend)]);
    return { usd: Number(r.rows[0].s), reversals: Number(r.rows[0].reversals) };
  };
  const credited = async (spend) => (await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = $1`, [keyOf(spend)])).rowCount;

  await t.test('PB2: a full refund of a failed-ledger donation, then reconcile → the ledger nets 0.00', async () => {
    const id = await failedDonation('g5test-a');
    const r = await refund('g5test-a', 'stripe:refund:g5test-ra');
    assert.equal(r.statusCode, 202, 'a refund the ledger cannot apply yet must be HELD, not answered "nothing to reverse"');
    assert.equal(r.body.held, 'pending');
    assert.equal(await credited('g5test-a'), 0, 'holding a refund must not write a ledger row');
    const rec = await call('/support/reconcile', { id, amountUsd: 10 });
    assert.equal(rec.body.credited, true);
    assert.deepEqual(await net('g5test-a'), { usd: 0, reversals: 1 }, 'reconcile credited a refunded payment in full');
    const hold = (await pool.query(`SELECT status FROM stream.support_reversal_holds WHERE event_id = $1`, [keyOf('g5test-a')])).rows[0];
    assert.equal(hold.status, 'applied');
    assert.ok(sponsorResets >= 1, 'reconcile must rebuild the sponsor pool after taking a held reversal back');
  });

  await t.test('PB2: a partial refund before reconcile nets the remainder', async () => {
    const id = await failedDonation('g5test-b');
    assert.equal((await refund('g5test-b', 'stripe:refund:g5test-rb', { refunded: 250, gross: 1000 })).statusCode, 202);
    await call('/support/reconcile', { id, amountUsd: 10 });
    assert.deepEqual(await net('g5test-b'), { usd: 7.5, reversals: 1 });
  });

  await t.test('PB2: replayed webhooks are idempotent — before the credit, after it, and after reconcile', async () => {
    const id = await failedDonation('g5test-c');
    for (let i = 0; i < 3; i++) assert.equal((await refund('g5test-c', 'stripe:refund:g5test-rc')).statusCode, 202);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM stream.support_reversal_holds WHERE event_id = $1`, [keyOf('g5test-c')])).rows[0].n, 1);
    await call('/support/reconcile', { id, amountUsd: 10 });
    const again = await refund('g5test-c', 'stripe:refund:g5test-rc');
    assert.equal(again.statusCode, 200);
    assert.ok(again.body.deduped === true || again.body.amountUsd === 0, `a redelivery after the hold applied reversed again: ${JSON.stringify(again.body)}`);
    await call('/support/reconcile', { id, amountUsd: 10 });
    assert.deepEqual(await net('g5test-c'), { usd: 0, reversals: 1 });
  });

  await t.test('PB2: reconcile and reverse at the same time net exactly once', async () => {
    for (let i = 0; i < 12; i++) {
      const spend = `g5test-race${i}`;
      const id = await failedDonation(spend);
      const [a, b] = await Promise.all(i % 2
        ? [refund(spend, `stripe:refund:g5test-race${i}`), call('/support/reconcile', { id, amountUsd: 10 })]
        : [call('/support/reconcile', { id, amountUsd: 10 }), refund(spend, `stripe:refund:g5test-race${i}`)]);
      assert.ok([a, b].every((x) => x.statusCode < 300), `race ${i}: ${a.statusCode}/${b.statusCode}`);
      assert.deepEqual(await net(spend), { usd: 0, reversals: 1 }, `race ${i} did not net exactly once`);
    }
  });

  await t.test('PB2: a refund of a payment found NOWHERE is held, and the late delivery takes it back', async () => {
    const r = await refund('g5test-d', 'stripe:refund:g5test-rd');
    assert.equal(r.statusCode, 202);
    assert.equal(r.body.held, 'pending');
    await quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 10, eventId: 'donation:donation:g5test-d' }));
    assert.equal(await credited('g5test-d'), 1, 'the late delivery did not credit');
    assert.deepEqual(await net('g5test-d'), { usd: 0, reversals: 1 });
    assert.equal(reversedCalls, 1, 'a late delivery that took a held reversal back must rebuild the sponsor pool');
  });

  await t.test('PB2: a late delivery that settles a ledger_failed row takes a held partial refund back', async () => {
    await failedDonation('g5test-e', 8);
    await refund('g5test-e', 'stripe:refund:g5test-re', { refunded: 500, gross: 1000 });
    await quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 8, eventId: 'donation:donation:g5test-e' }));
    assert.deepEqual(await net('g5test-e'), { usd: 4, reversals: 1 });
    const st = (await pool.query(`SELECT status FROM stream.unpriced_support WHERE event_id = $1`, [keyOf('g5test-e')])).rows[0].status;
    assert.equal(st, 'reconciled');
  });

  await t.test('PB2: a restore of a held refund cancels it; the credit then lands whole', async () => {
    const id = await failedDonation('g5test-f');
    await refund('g5test-f', 'stripe:refund:g5test-rf');
    const restore = await call('/support/reverse', { kind: 'donation', spendId: 'donation:g5test-f', ref: 'stripe:refund:g5test-rf', reason: 'restore' });
    assert.equal(restore.statusCode, 200);
    assert.equal(restore.body.held, 'cancelled');
    await call('/support/reconcile', { id, amountUsd: 10 });
    assert.deepEqual(await net('g5test-f'), { usd: 10, reversals: 0 });
  });

  await t.test('PB2: a restore that arrives FIRST makes its late opening event take nothing', async () => {
    const id = await failedDonation('g5test-g');
    const restore = await call('/support/reverse', { kind: 'donation', spendId: 'donation:g5test-g', ref: 'stripe:dispute:g5test-dg', reason: 'restore' });
    assert.equal(restore.body.held, 'cancelled');
    const open = await call('/support/reverse', { kind: 'donation', spendId: 'donation:g5test-g', ref: 'stripe:dispute:g5test-dg', reason: 'dispute' });
    assert.equal(open.statusCode, 200);
    assert.equal(open.body.amountUsd, 0);
    await call('/support/reconcile', { id, amountUsd: 10 });
    assert.deepEqual(await net('g5test-g'), { usd: 10, reversals: 0 });
    // …and once the credit is there, the same opening event still takes nothing.
    const later = await call('/support/reverse', { kind: 'donation', spendId: 'donation:g5test-g', ref: 'stripe:dispute:g5test-dg', reason: 'dispute' });
    assert.equal(later.body.amountUsd, 0);
    assert.deepEqual(await net('g5test-g'), { usd: 10, reversals: 0 });
  });

  await t.test('PB2: a dismissed row keeps its hold pending and credits nothing', async () => {
    const id = await failedDonation('g5test-h');
    await refund('g5test-h', 'stripe:refund:g5test-rh');
    await call('/support/reconcile', { id, dismiss: true });
    assert.deepEqual(await net('g5test-h'), { usd: 0, reversals: 0 });
    const hold = (await pool.query(`SELECT status FROM stream.support_reversal_holds WHERE event_id = $1`, [keyOf('g5test-h')])).rows[0];
    assert.equal(hold.status, 'pending');
  });

  // Round-5 follow-up: a credit that lands already fully refunded celebrates NOTHING — no alert, no
  // sound/TTS, no chat card. The ledger row is still written, with its reversal, in one transaction,
  // and since round 6 (D-D) the bar and the timer move by its net — nothing here. A partial refund
  // still celebrates.
  const shows = () => frames.filter((f) => f.type === 'showAlert').length;
  const cards = () => frames.filter((f) => f.type === 'message' && f.platform === 'system' || f.system === 'donation').length;

  await t.test('a late delivery whose held refunds cover the WHOLE amount fires no celebration; ledger + reversal still written', async () => {
    await refund('g5test-i', 'stripe:refund:g5test-ri');
    frames.length = 0; barAdds.length = 0;
    const out = await quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 10, eventId: 'donation:donation:g5test-i', message: 'thank you' }));
    assert.equal(shows(), 0, 'a refunded payment was celebrated on stream');
    assert.equal(out.refunded, true);
    assert.equal(await credited('g5test-i'), 1, 'the ledger row must still be written');
    assert.deepEqual(await net('g5test-i'), { usd: 0, reversals: 1 });
    // Round 6 D-D (k, 2026-10-18) replaced the round-4 rule this line used to pin (`[10]`): a credit
    // whose held refunds cover it whole moves the bar and the timer by nothing. Net, live and
    // rebuilt: support-held-net-bar.db.test.js.
    assert.deepEqual(barAdds, [], 'a fully refunded credit moved the bar/timer');
  });

  await t.test('the native /chat/event path posts no card for a fully refunded donation', async () => {
    await refund('g5test-j', 'stripe:refund:g5test-rj');
    frames.length = 0;
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await quietly(() => routes['/chat/event']({ body: { kind: 'donation', donor: 'casey', donorMatrixId: DONOR, amount: 1000,
      currency: 'usd', message: 'hi', spendId: 'donation:g5test-j' } }, res));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.refunded, true, JSON.stringify(res.body));
    assert.equal(shows(), 0, 'a refunded payment was celebrated');
    assert.equal(cards(), 0, 'a refunded payment got a chat card');
    assert.equal(await credited('g5test-j'), 1);
    assert.equal((await net('g5test-j')).usd, 0);
  });

  await t.test('a PARTIAL held refund still celebrates', async () => {
    await refund('g5test-k', 'stripe:refund:g5test-rk', { refunded: 500, gross: 1000 });
    frames.length = 0;
    const out = await quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 10, eventId: 'donation:donation:g5test-k' }));
    assert.equal(shows(), 1, 'a partly refunded payment lost its celebration');
    assert.ok(!out.refunded);
    assert.deepEqual(await net('g5test-k'), { usd: 5, reversals: 1 });
  });
});
