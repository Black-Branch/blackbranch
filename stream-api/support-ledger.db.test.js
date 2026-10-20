// The support ledger's two new writers against a REAL Postgres (v154), and every consumer's answer:
//   • POST /support/reverse — a refund or dispute writes a NEGATIVE row keyed to the original
//     event (idempotent per refund, partial = its share, never more than remains, restorable).
//     Lifetime support + tier (aggregates → /user/lookup) and sponsor weighting go DOWN; the
//     per-stream bar (supportbar.init) does NOT move, and nothing reaches the timer or the meter.
//   • POST /support/reconcile — an unpriced payment credited under its STORED event_id with no
//     effects; a re-post of that event is a duplicate before and after.
// Fixtures are scoped to ids beginning `g1test` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test support-ledger.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createAlert } = require('./alert');
const { createMoney, makeRecordSupport, makeRecordUnpriced } = require('./money');
const { createSupportBar } = require('./supportbar');
const { createAggregates } = require('./aggregates');
const { createSponsors } = require('./sponsors');
const { registerProfileRoutes } = require('./profiles');
const economics = require('./economics');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const SESSION = 'g1test-session';
const DONOR = '@g1test-casey:site.test';

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

test('support ledger reversals and reconciliation against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => serially(pool, async () => {
    const users = (await pool.query(
      `SELECT DISTINCT user_id FROM stream.support_events WHERE event_id LIKE '%g1test%'`)).rows.map((r) => r.user_id);
    await pool.query(`DELETE FROM stream.support_events WHERE reverses_id IN (SELECT id FROM stream.support_events WHERE event_id LIKE '%g1test%')`);
    await pool.query(`DELETE FROM stream.support_events WHERE event_id LIKE '%g1test%'`);
    await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE '%g1test%'`);
    await pool.query(`DELETE FROM stream.support_reversal_holds WHERE event_id LIKE '%g1test%'`);
    const linked = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE '%g1test%'`)).rows.map((r) => r.canonical);
    const all = [...new Set([...users, ...linked])];
    if (all.length) {
      await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [all]);
    }
    await pool.query(`DELETE FROM stream.sessions WHERE stream_id = $1`, [SESSION]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO stream.sessions (stream_id, started_at) VALUES ($1, NOW() - interval '1 hour')`, [SESSION]);
  const liveState = async () => ({ live: true, streamId: SESSION });
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const recordSupport = makeRecordSupport({ pool, resolveOrCreate: identity.resolveOrCreate, liveState });
  const recordUnpriced = makeRecordUnpriced({ pool, liveState });
  const frames = [];
  const barAdds = [];
  const alert = createAlert({
    broadcast: (m) => frames.push(m), bufferPush: () => {}, obs: null, tts: null, lights: null,
    supportBar: { add: (v) => { barAdds.push(v); return { deltaSeconds: 0 }; } },
    logSupport: recordSupport, logUnpriced: recordUnpriced, persistCard: async () => null,
  });
  let sponsorResets = 0;
  const money = createMoney({
    pool, economics, alert, recordSupport, broadcast: (m) => frames.push(m), bufferPush: () => {},
    sponsors: { reset: async () => { sponsorResets++; } },
  });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
    { requireInternal: (_q, _s, n) => n(), requireSecret: (_q, _s, n) => n(), wrap: (fn) => fn });
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await quietly(() => routes[path]({ body }, res));
    return res;
  };
  // The aggregate rebuild is a whole-table pass, so it runs inside a transaction that is rolled
  // back: no other file's fixture person ever gets a committed user_stats row from it. It can still
  // lose a race with a parallel file deleting a person (the refresher only logs that) — then once more.
  const withRebuilt = async (read) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let failed = false;
      const value = await serially(pool, async () => {
        const client = await pool.connect();
        const saved = { warn: console.warn, log: console.log };
        console.log = () => {};
        console.warn = (...a) => { if (/refresh failed/.test(a.join(' '))) failed = true; };
        try {
          await client.query('BEGIN');
          const db = { query: (...a) => client.query(...a) };
          await createAggregates({ pool: db, schedule: () => {}, excludeEventTypes: [] }).requestAggregateRefresh();
          return failed ? null : await read(db);
        } finally {
          Object.assign(console, saved);
          await client.query('ROLLBACK').catch(() => {});
          client.release();
        }
      });
      if (!failed) return value;
    }
    throw new Error('the aggregate rebuild failed three times');
  };
  const supportOf = (canonical) => withRebuilt(async (db) => {
    const r = await db.query(`SELECT support FROM stream.user_stats WHERE user_id = $1`, [canonical]);
    return r.rows[0] ? Number(r.rows[0].support) : null;
  });
  const barTotal = () => quietly(() => createSupportBar({ pool, broadcast: () => {}, getStreamId: async () => SESSION, earnTime: () => 0 }).init());

  // A native $10 donation (as /chat/event's donation handler sends it).
  const SPEND = 'donation:g1test-cs1';
  await quietly(() => alert.fireStreamEffects({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
    takeHomeUSD: 10, eventId: `donation:${SPEND}` }));
  const orig = (await pool.query(`SELECT id, user_id, amount_usd FROM stream.support_events WHERE event_id = $1`,
    [`alert:native:donation:${SPEND}`])).rows[0];
  assert.ok(orig, 'the donation did not write its ledger row — every check below would be vacuous');
  const canonical = orig.user_id;

  await t.test('before any refund: lifetime support and the bar both read the donation', async () => {
    assert.equal(await supportOf(canonical), 10);
    assert.equal(await barTotal(), 10);
  });

  await t.test('a partial refund reverses its share only, once however often it is delivered', async () => {
    frames.length = 0;
    const barBefore = barAdds.length;
    const first = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:refund:g1test-re1', reason: 'refund', refunded: 500, gross: 1000 });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.amountUsd, -5);
    const again = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:refund:g1test-re1', reason: 'refund', refunded: 500, gross: 1000 });
    assert.deepEqual(again.body, { ok: true, deduped: true });
    const rows = (await pool.query(`SELECT amount_usd, event_type, stream_id, reverses_id FROM stream.support_events WHERE reverses_id = $1`, [orig.id])).rows;
    assert.equal(rows.length, 1, 'the same refund twice wrote two reversals');
    assert.deepEqual({ ...rows[0], amount_usd: Number(rows[0].amount_usd), reverses_id: String(rows[0].reverses_id) },
      { amount_usd: -5, event_type: 'reversal', stream_id: null, reverses_id: String(orig.id) });
    assert.equal(frames.length, 0, 'a reversal broadcast something — it must have NO effects');
    assert.equal(barAdds.length, barBefore, 'a reversal moved the live bar');
    assert.ok(sponsorResets >= 1, 'the sponsor pool was not rebuilt from the ledger');
  });

  await t.test('consumers after the partial refund: lifetime support and /user/lookup go down; the per-stream bar does not', async () => {
    assert.equal(await supportOf(canonical), 5, 'lifetime support (aggregates) ignored the reversal');
    assert.equal(await barTotal(), 10, 'the per-stream bar summed the reversal — it must stay untouched');
    const body = await withRebuilt(async (db) => {
      const lroutes = {};
      registerProfileRoutes({ get: (p, ...h) => { lroutes[p] = h[h.length - 1]; } }, { pool: db, requireInternal: () => {}, wrap: (fn) => fn });
      let out = null;
      const res = { status: () => res, json: (b) => { out = b; return res; } };
      await lroutes['/user/lookup']({ query: { canonicalId: canonical } }, res);
      return out;
    });
    assert.equal(Number(body.support), 5, '/user/lookup (the tier read) still carries the refunded money');
  });

  await t.test('sponsor weighting nets the reversal onto its original', async () => {
    const sponsors = createSponsors({
      pool, broadcast: () => {}, getStreamId: async () => SESSION,
      timer: { snapshot: () => ({ night: { active: false, elapsedSec: 0 }, usdPerHour: 36 }) },
    });
    await quietly(() => sponsors.init());
    const total = [...sponsors.__test.state.values()].reduce((s, e) => s + e.weightSec, 0);
    // $5 kept at $36/h = 500 notional seconds (it was 1000 before the refund).
    assert.equal(total, 500);
  });

  await t.test('a second refund takes at most what remains; a third finds nothing', async () => {
    const full = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:dispute:g1test-dp1', reason: 'dispute' });
    assert.equal(full.body.amountUsd, -5, 'a full reversal after a partial one must take only the remainder');
    const none = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:refund:g1test-re2', reason: 'refund' });
    assert.deepEqual(none.body, { ok: true, amountUsd: 0 });
    assert.equal(await supportOf(canonical), 0);
  });

  await t.test('a won dispute restores what its reversal took, once', async () => {
    const r = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:dispute:g1test-dp1', reason: 'restore' });
    assert.equal(r.body.amountUsd, 5);
    const again = await call('/support/reverse', { kind: 'donation', spendId: SPEND, ref: 'stripe:dispute:g1test-dp1', reason: 'restore' });
    assert.deepEqual(again.body, { ok: true, deduped: true });
    assert.equal(await supportOf(canonical), 5);
  });

  await t.test('a refund of a payment the ledger never credited is HELD (202), and writes no ledger row', async () => {
    const r = await call('/support/reverse', { kind: 'donation', spendId: 'donation:g1test-never', ref: 'stripe:refund:g1test-x', reason: 'refund' });
    assert.equal(r.statusCode, 202);
    assert.equal(r.body.held, 'pending');
    assert.equal((await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id LIKE '%g1test-never%'`)).rowCount, 0);
  });

  await t.test('a malformed body is refused', async () => {
    for (const b of [{}, { kind: 'cheer', spendId: 'x', ref: 'r', reason: 'refund' }, { kind: 'donation', spendId: SPEND, ref: 'r', reason: 'oops' }]) {
      assert.equal((await call('/support/reverse', b)).statusCode, 400);
    }
  });

  // ── unpriced reconciliation ──────────────────────────────────────────────────

  const UNPRICED = { platform: 'youtube', eventType: 'superchat', username: 'casey', amount: 5000, currency: 'UNKNOWN',
    amountText: 'F CFA 5,000', message: 'hola', label: 'super chat', eventId: 'youtube:g1test-u1' };
  const KEY = 'alert:youtube:youtube:g1test-u1';

  await t.test('an unpriced payment re-posted WITH a price is a duplicate: no second celebration, no ledger row', async () => {
    frames.length = 0;
    await quietly(() => alert.dispatch(UNPRICED));
    assert.equal(frames.filter((f) => f.type === 'showAlert').length, 1);
    const repost = await quietly(() => alert.dispatch({ ...UNPRICED, currency: 'USD', amount: 7 }));
    assert.deepEqual(repost, { ok: true, deduped: true });
    assert.equal(frames.filter((f) => f.type === 'showAlert').length, 1, 'the re-post celebrated again');
    const led = await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = $1`, [KEY]);
    assert.equal(led.rowCount, 0, 'the re-post credited the ledger behind the reconciliation path');
  });

  await t.test('reconcile credits the stored event_id with no effects, once', async () => {
    const row = (await pool.query(`SELECT id, status FROM stream.unpriced_support WHERE event_id = $1`, [KEY])).rows[0];
    assert.equal(row.status, 'open');
    frames.length = 0;
    const barBefore = barAdds.length;
    const r = await call('/support/reconcile', { id: Number(row.id), amountUsd: 3.5 });
    assert.deepEqual(r.body, { ok: true, status: 'reconciled', credited: true });
    const led = (await pool.query(`SELECT amount_usd, stream_id FROM stream.support_events WHERE event_id = $1`, [KEY])).rows;
    assert.equal(led.length, 1);
    assert.equal(Number(led[0].amount_usd), 3.5);
    assert.equal(led[0].stream_id, SESSION, 'the credit must belong to the stream the payment arrived in');
    assert.equal(frames.length, 0, 'reconciling fired an effect');
    assert.equal(barAdds.length, barBefore, 'reconciling moved the live bar');
    const st = (await pool.query(`SELECT status, reconciled_amount_usd, reconciled_at FROM stream.unpriced_support WHERE id = $1`, [row.id])).rows[0];
    assert.equal(st.status, 'reconciled');
    assert.equal(Number(st.reconciled_amount_usd), 3.5);
    assert.ok(st.reconciled_at);
    const again = await call('/support/reconcile', { id: Number(row.id), amountUsd: 99 });
    assert.deepEqual(again.body, { ok: true, deduped: true, status: 'reconciled', amountUsd: 3.5 });
    assert.equal((await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = $1`, [KEY])).rowCount, 1);
  });

  await t.test('after reconciliation a re-post is still a duplicate', async () => {
    frames.length = 0;
    const out = await quietly(() => alert.dispatch(UNPRICED));
    assert.deepEqual(out, { ok: true, deduped: true });
    assert.equal(frames.length, 0);
  });

  // ── a ledger write that cannot succeed (security review) ─────────────────────

  await t.test('a permanent database error (numeric overflow, class 22) is not retried: recorded as ledger_failed, nothing fires', async () => {
    frames.length = 0;
    const barBefore = barAdds.length;
    let err;
    await quietly(async () => {
      try {
        await alert.dispatch({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
          takeHomeUSD: 1e12, eventId: 'donation:donation:g1test-huge' });
      } catch (e) { err = e; }
    });
    assert.equal(err && err.code, 'LEDGER_WRITE_FAILED', 'dispatch must reject so the caller answers non-2xx');
    assert.equal(err.permanent, true);
    assert.equal(frames.length, 0, 'an effect fired for an event the ledger does not hold');
    assert.equal(barAdds.length, barBefore);
    const row = (await pool.query(`SELECT reason, status, currency, amount_native FROM stream.unpriced_support WHERE event_id = 'alert:native:donation:donation:g1test-huge'`)).rows[0];
    assert.ok(row, 'the failed event was not recorded for reconciliation');
    assert.deepEqual({ reason: row.reason, status: row.status, currency: row.currency, amount: Number(row.amount_native) },
      { reason: 'ledger_failed', status: 'open', currency: 'USD', amount: 1e12 });
  });

  await t.test('a ledger_failed event that a later delivery does credit is settled by itself', async () => {
    const key = 'alert:native:donation:donation:g1test-later';
    await recordUnpriced({ platform: 'native', eventType: 'donation', username: 'casey', amountNative: 4, currency: 'USD',
      raw: 'ledger write failed (08006)', eventId: key, reason: 'ledger_failed' });
    await quietly(() => alert.dispatch({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 4, eventId: 'donation:donation:g1test-later' }));
    assert.equal((await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = $1`, [key])).rowCount, 1,
      'a ledger_failed record must not block the real credit the way an unpriced one does');
    const row = (await pool.query(`SELECT status, reconciled_amount_usd FROM stream.unpriced_support WHERE event_id = $1`, [key])).rows[0];
    assert.equal(row.status, 'reconciled');
    assert.equal(Number(row.reconciled_amount_usd), 4);
  });

  await t.test('a DISMISSED ledger_failed row keeps blocking credit; an open one does not', async () => {
    const key = 'alert:native:donation:donation:g1test-dism';
    await recordUnpriced({ platform: 'native', eventType: 'donation', username: 'casey', amountNative: 2, currency: 'USD',
      raw: 'ledger write failed', eventId: key, reason: 'ledger_failed' });
    await pool.query(`UPDATE stream.unpriced_support SET status = 'dismissed' WHERE event_id = $1`, [key]);
    frames.length = 0;
    const out = await quietly(() => alert.dispatch({ platform: 'native', eventType: 'donation', username: 'casey', userId: DONOR,
      takeHomeUSD: 2, eventId: 'donation:donation:g1test-dism' }));
    assert.deepEqual(out, { ok: true, deduped: true }, 'a dismissed record stopped blocking a credit');
    assert.equal((await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = $1`, [key])).rowCount, 0);
    assert.equal(frames.length, 0);
  });

  await t.test('a ledger_failed row with NO event id is refused by /support/reconcile', async () => {
    const r = await pool.query(`INSERT INTO stream.unpriced_support (event_id, platform, event_type, username, amount_native, currency, raw, reason)
      VALUES (NULL, 'native', 'donation', 'casey', 3, 'USD', 'g1test-null', 'ledger_failed') RETURNING id`);
    const id = Number(r.rows[0].id);
    try {
      const res = await call('/support/reconcile', { id, amountUsd: 3 });
      assert.equal(res.statusCode, 409);
      assert.equal((await pool.query(`SELECT status FROM stream.unpriced_support WHERE id = $1`, [id])).rows[0].status, 'open');
    } finally {
      await pool.query(`DELETE FROM stream.unpriced_support WHERE id = $1`, [id]);
    }
  });

  await t.test('a NUL in a donor name no longer fails the write: it is cleaned before the INSERT', async () => {
    await quietly(() => alert.dispatch({ platform: 'streamlabs', eventType: 'donation', username: 'ca\u0000sey', amount: 5, currency: 'USD',
      eventId: 'g1test-nul' }));
    const row = (await pool.query(`SELECT username FROM stream.support_events WHERE event_id = 'alert:streamlabs:g1test-nul'`)).rows[0];
    assert.ok(row, 'the donation with a NUL in its name did not reach the ledger');
    assert.equal(row.username, 'ca sey');
  });

  await t.test('dismiss closes a row with no credit; bad bodies are refused; unknown ids 404', async () => {
    await quietly(() => alert.dispatch({ ...UNPRICED, eventId: 'youtube:g1test-u2' }));
    const row = (await pool.query(`SELECT id FROM stream.unpriced_support WHERE event_id = 'alert:youtube:youtube:g1test-u2'`)).rows[0];
    const r = await call('/support/reconcile', { id: Number(row.id), dismiss: true });
    assert.deepEqual(r.body, { ok: true, status: 'dismissed', credited: false });
    assert.equal((await pool.query(`SELECT 1 FROM stream.support_events WHERE event_id = 'alert:youtube:youtube:g1test-u2'`)).rowCount, 0);
    assert.equal((await call('/support/reconcile', { id: Number(row.id) + 100000 , amountUsd: 1 })).statusCode, 404);
    assert.equal((await call('/support/reconcile', { id: 'x', amountUsd: 1 })).statusCode, 400);
    assert.equal((await call('/support/reconcile', { id: Number(row.id), amountUsd: 0 })).statusCode, 400);
  });
});
