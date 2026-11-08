// A community gift whose EVERY slot is parked (no eligible user at purchase) is still the
// streamer's money (area-1 W4 R1).
//
// buildEventCard returned null for a gift with no recipients, and /chat/event answered
// "nothing to announce" BEFORE crediting, so such a gift's whole charge never reached the bar,
// stream.support_events, lifetime support or sponsor weighting, and no card posted; later sign-ups
// claimed the slots silently. Now a community gift is credited and announced at purchase whatever
// its slots' state ("gifted N subs to the community — waiting for the next sign-ups" when all are
// parked), and the ledger holds it once across a redelivery and a restart. A DIRECT gift with no
// recipient still announces nothing (it cannot exist: its grant names the recipient).
//
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test chat-event-parked-gift.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createAlert, buildEventCard } = require('./alert');
const { createMoney, makeRecordSupport, makeRecordUnpriced } = require('./money');
const economics = require('./economics');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const GIFTER = '@w4parked-casey:site.test';
const SESSION = 'cs_w4parked_1';
const PARKED = {
  kind: 'gift', spendId: `gift:${SESSION}`, gifter: 'casey', gifterMatrixId: GIFTER, anonymous: false,
  giftKind: 'community', months: 1, count: 3, amount: 1500, currency: 'usd', recipients: [],
};

test('the card: a community gift with every slot parked is a card, counted by the slots bought', () => {
  const base = { type: 'message', platform: 'system', id: 'g1', system: 'gift', ts: 1 };
  const card = buildEventCard('gift', PARKED, base);
  assert.ok(card, 'a parked community gift must still be announced');
  assert.equal(card.count, 3);
  assert.deepEqual(card.recipients, []);
  assert.equal(card.waiting, true);
  // Partly parked: the card counts what was BOUGHT, not only who was granted now.
  const partly = buildEventCard('gift', { ...PARKED, recipients: [{ name: 'R', matrixId: '@r:site.test' }] }, base);
  assert.equal(partly.count, 3);
  assert.equal(partly.waiting, false);
  // An older caller that sends no count keeps today's answer.
  assert.equal(buildEventCard('gift', { ...PARKED, count: undefined }, base), null);
  assert.equal(buildEventCard('gift', { ...PARKED, giftKind: 'direct', count: 1 }, base), null, 'a direct gift names its recipient or is nothing');
});

test('a direct gift queued behind its recipient subscription says so on the PUBLIC card, never when (A1-03)', () => {
  const base = { type: 'message', platform: 'system', id: 'g2', system: 'gift', ts: 1 };
  const direct = { ...PARKED, giftKind: 'direct', count: 1, recipients: [{ name: 'R', matrixId: '@r:site.test' }] };
  const queued = buildEventCard('gift', { ...direct, queued: true, startsAt: '2026-11-26T05:50:33.000Z' }, base);
  assert.equal(queued.queued, true);
  assert.equal('startsAt' in queued, false, 'one person\'s renewal date never rides a public card, whatever the caller sends');
  assert.ok(!JSON.stringify(queued).includes('2026-11-26'));
  assert.equal(buildEventCard('gift', direct, base).queued, false);
  assert.equal(buildEventCard('gift', { ...PARKED, queued: true }, base).queued, false, 'a community gift is never queued behind anyone');
});

test('zero eligible users at purchase: one ledger row, one card, across a redelivery and a restart', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => serially(pool, async () => {
    const users = (await pool.query(
      `SELECT DISTINCT user_id FROM stream.support_events WHERE event_id LIKE '%w4parked%'`)).rows.map((r) => r.user_id);
    await pool.query(`DELETE FROM stream.support_events WHERE event_id LIKE '%w4parked%'`);
    await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE '%w4parked%'`);
    const linked = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE '%w4parked%'`)).rows.map((r) => r.canonical);
    const all = [...new Set([...users, ...linked])];
    if (all.length) {
      await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [all]);
      await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [all]);
    }
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const liveState = async () => ({ live: false, streamId: null });
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  /** One stream-api process: its own outcome store, the shared ledger. */
  const process_ = () => {
    const cards = [];
    const alert = createAlert({
      broadcast: () => {}, bufferPush: () => {}, obs: null, tts: null, lights: null,
      supportBar: { add: () => ({ deltaSeconds: 0 }) },
      logSupport: makeRecordSupport({ pool, resolveOrCreate: identity.resolveOrCreate, liveState }),
      logUnpriced: makeRecordUnpriced({ pool, liveState }), persistCard: async () => null,
    });
    const money = createMoney({
      pool, economics, alert, broadcast: (m) => { if (m.type === 'message') cards.push(m); }, bufferPush: () => {},
      persistEventCard: async () => 1, maskBlacklist: (s) => s,
    });
    const routes = {};
    money.registerMoneyRoutes(
      { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), requireSecret: (_q, _s, n) => n(), wrap: (fn) => fn });
    const post = async (body) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      const saved = { log: console.log, warn: console.warn, error: console.error };
      console.log = () => {}; console.warn = () => {}; console.error = () => {};
      try { await routes['/chat/event']({ body }, res); } finally { Object.assign(console, saved); }
      return res;
    };
    return { post, cards };
  };
  const rows = async () => (await pool.query(
    `SELECT amount_usd FROM stream.support_events WHERE event_id = $1`, [`alert:native:gift:${PARKED.spendId}`])).rows;

  const first = process_();
  const r1 = await first.post(PARKED);
  assert.equal(r1.statusCode, 200);
  assert.notEqual(r1.body.skipped, 'nothing to announce', 'the parked gift was skipped before crediting');
  assert.equal((await rows()).length, 1, 'the purchase is in the ledger');
  assert.ok(Number((await rows())[0].amount_usd) > 0, 'credited its take-home');
  assert.equal(first.cards.length, 1, 'one card');
  assert.equal(first.cards[0].waiting, true);

  await first.post(PARKED); // retry: the same process (outcome store)
  const restarted = process_(); // restart: a new process, an empty outcome store
  await restarted.post(PARKED);
  assert.equal((await rows()).length, 1, 'a redelivery and a restart credit nothing more');
  assert.equal(first.cards.length + restarted.cards.length, 1, 'no second card');
});
