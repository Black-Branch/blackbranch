// A gift to someone already paying monthly starts AFTER their paid term (area-1 round 2, A1-03 /
// P08; k 2026-10-25): never overlapping a month they pay for, never pausing their card.
//
// The gift used to be dated once, at the end of the CURRENT paid period; the card then renewed on
// schedule, so the subscriber paid for every month the gift "covered". Now a gift granted behind a
// subscription FOLLOWS it (`follows_subscription`): every time the paid term moves (a renewal, a
// cancellation, a refund) the transition function re-dates every gift still queued behind it, in
// the same transaction, so it begins when the paying stops. A gift that has begun with no paid
// time over it is running and stays put. A gift running when someone subscribes is never moved.
//
// Runs on a replayed Postgres (CI sets SQL_PARSE_DATABASE_URL).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import type { Observation, Provider } from "./types.ts";

const { writeTransition } = await import("./state.ts");
const { realignQueuedGifts, queuedGiftStart } = await import("./giftQueue.ts");
const { createGiftRecorder } = await import("../giftServer.ts");
const { GIFT_GIVEN_DATES_SQL } = await import("../giftLedger.ts");

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `gq${process.pid}x${Date.now().toString(36)}`;
const SOURCES: Provider[] = ["stripe", "paypal"];
const DAY = 86_400_000;
let seq = 0;

test("a gift to a paying subscriber follows their paid term", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const clean = async () => {
    await pool.query(`DELETE FROM site.gift_subscriptions WHERE stripe_session_id LIKE $1`, [`cs_${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_records WHERE external_id LIKE $1`, [`sub_${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const fresh = async () => {
    const n = ++seq;
    const who = `@${RUN}-r${n}:site.test`, gifter = `@${RUN}-g${n}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2)`, [who, gifter]);
    return { who, gifter, sub: `sub_${RUN}_${n}`, session: `cs_${RUN}_${n}` };
  };
  /** The Stripe adapter's observation of the viewer's card subscription, written by the ONE writer. */
  const observe = async (who: string, sub: string, o: { periodEnd: Date; status?: Observation["status"]; renews?: boolean; at: Date; accessUntil?: Date }) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await writeTransition(c, { via: "webhook", viewer: who, sources: SOURCES, observations: [{
        provider: "stripe", externalId: sub, tier: "supporter", status: o.status ?? "active", providerStatus: o.status === "ended" ? "canceled" : "active",
        renews: o.renews ?? true, periodEnd: o.periodEnd, accessUntil: o.accessUntil ?? o.periodEnd, observedAt: o.at }] });
      await c.query("COMMIT");
    } finally { c.release(); }
  };
  const gifts = async (who: string) => (await pool.query<{ start: Date; expires_at: Date; follows: boolean }>(
    `SELECT starts_at AS start, expires_at, follows_subscription AS follows
       FROM site.gift_subscriptions WHERE recipient_matrix_id = $1 ORDER BY id`, [who])).rows;
  const recorder = () => createGiftRecorder({
    pool, grantBadge: async () => {}, announce: async () => {}, granted: () => {}, priceCurrency: async () => "usd",
  });
  const gift = (session: string, gifter: string, who: string) => ({
    id: session, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: 500, currency: "usd",
    metadata: { kind: "gift", months: "1", anonymous: "0", gift_type: "direct", gifter_matrix_id: gifter, recipient_matrix_id: who },
  }) as never;
  const near = (a: Date, b: Date) => Math.abs(new Date(a).getTime() - b.getTime()) < 1000;

  await t.test("a gift to a renewing subscriber starts at their period end and follows each renewal", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 5 * DAY), end2 = new Date(end1.getTime() + 30 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 60_000) });
    await recorder().recordGift(gift(session, gifter, who));
    let [g] = await gifts(who);
    assert.ok(g!.follows, "granted behind a subscription: it follows it");
    assert.ok(near(g!.start, end1), "starts when the paid period ends");
    // The card renews: the paid term moves a month, and the gift with it — the subscriber never pays
    // for a month the gift covers.
    await observe(who, sub, { periodEnd: end2, at: new Date() });
    [g] = await gifts(who);
    assert.ok(near(g!.start, end2), `the renewal moved the gift to the new period end (got ${new Date(g!.start).toISOString()})`);
    assert.equal(await queuedGiftStart(pool, who), new Date(g!.start).toISOString(), "the date the panel tells them");
  });

  // Security review (round 2): the chat card is PUBLIC, and a queued gift's start is the recipient's
  // renewal date — one person's billing data. The card says only that the gift is queued after
  // their current subscription; the date is the recipient's alone (the Support panel, /api/me).
  await t.test("the public gift card says a gift is queued, never when; the recipient's own view has the date", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 7 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date() });
    const said: Record<string, unknown>[] = [];
    await createGiftRecorder({
      pool, grantBadge: async () => {}, announce: async (a) => { said.push({ ...a }); }, granted: () => {}, priceCurrency: async () => "usd",
    }).recordGift(gift(session, gifter, who));
    assert.equal(said.length, 1);
    assert.equal(said[0]!.queued, true, "the card says the gift is queued after their current subscription");
    assert.equal("startsAt" in said[0]!, false, "no start date rides the public announce");
    const iso = /\d{4}-\d{2}-\d{2}T/;
    for (const [k, v] of Object.entries(said[0]!)) assert.ok(!(typeof v === "string" && iso.test(v)), `the announce's ${k} carries a date`);
    const own = await queuedGiftStart(pool, who);
    assert.ok(own && near(new Date(own), end1), "the recipient's own view (/api/me giftStartsAt) has the date");
  });

  await t.test("the gifter's own list gets no date for a queued gift (review R5)", async () => {
    const { who, gifter, sub, session } = await fresh();
    await observe(who, sub, { periodEnd: new Date(Date.now() + 8 * DAY), at: new Date() });
    await recorder().recordGift(gift(session, gifter, who));
    const { rows } = await pool.query<{ expires_at: Date | null; queued: boolean }>(
      `SELECT ${GIFT_GIVEN_DATES_SQL} FROM site.gift_subscriptions g WHERE g.gifter_matrix_id = $1`, [gifter]);
    assert.deepEqual(rows, [{ expires_at: null, queued: true }], "the recipient's renewal date never reaches the gifter");
  });

  await t.test("the renewal webhook landing AFTER the old period end still moves a gift the card has paid over", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 2 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 120_000) });
    await recorder().recordGift(gift(session, gifter, who));
    // As if the gift's start had passed before the renewal's webhook arrived: date it an hour ago.
    await pool.query(`UPDATE site.gift_subscriptions SET starts_at = now() - interval '1 hour', expires_at = now() - interval '1 hour' + interval '1 month' WHERE recipient_matrix_id = $1`, [who]);
    const end2 = new Date(Date.now() + 30 * DAY);
    await observe(who, sub, { periodEnd: end2, at: new Date() });
    const [g] = await gifts(who);
    assert.ok(near(g!.start, end2), "the card paid over the gift's start: it moves after the new period");
  });

  await t.test("renewal off: the gift begins when the last paid period ends, and then stays put", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 3 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 120_000) });
    await recorder().recordGift(gift(session, gifter, who));
    await observe(who, sub, { periodEnd: end1, renews: false, at: new Date(Date.now() - 60_000) });
    let [g] = await gifts(who);
    assert.ok(near(g!.start, end1));
    // The subscription ends (written through the transition function): the gift begins at the end of
    // the paid term and is not moved. It keeps following for the grace days, so a renewal confirmed
    // late re-dates it back behind the new term; after them it is settled.
    await pool.query(`UPDATE site.gift_subscriptions SET starts_at = now() - interval '1 day', expires_at = now() - interval '1 day' + interval '1 month' WHERE recipient_matrix_id = $1`, [who]);
    const before = (await gifts(who))[0]!;
    await observe(who, sub, { periodEnd: new Date(Date.now() - DAY), status: "ended", renews: false, at: new Date() });
    [g] = await gifts(who);
    assert.ok(near(g!.expires_at, new Date(before.expires_at)), "a gift whose term ended is never moved");
    assert.equal(g!.follows, true, "within the grace days it still follows");
    await pool.query(`UPDATE site.gift_subscriptions SET starts_at = now() - interval '8 days', expires_at = now() - interval '8 days' + interval '1 month' WHERE recipient_matrix_id = $1`, [who]);
    const c = await pool.connect();
    try { await realignQueuedGifts(c, who, SOURCES); } finally { c.release(); }
    assert.equal((await gifts(who))[0]!.follows, false, "past the grace days: settled, never moved again");
  });

  // Review R2 (round 2): the hourly sweep (and the one at web start) ran in the gap between the old
  // period end and a LATE renewal webhook, saw the gift's start pass with no paid time over it, and
  // marked it running; the renewal then found nothing following and the subscriber paid for a gifted
  // month. A queued gift begins ONLY when the record says the paid term ended — never on the clock.
  await t.test("race: the sweep runs after the old period end and before a late renewal webhook — the renewal still re-dates the gift", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 2 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 180_000) });
    await recorder().recordGift(gift(session, gifter, who));
    // The old period end passes: the record still says active and renewing (its renewal is pending),
    // access within its grace days; the gift's start (the old end) is in the past.
    const oldEnd = new Date(Date.now() - 3_600_000);
    await observe(who, sub, { periodEnd: oldEnd, accessUntil: new Date(oldEnd.getTime() + 7 * DAY), at: new Date(Date.now() - 120_000) });
    await pool.query(`UPDATE site.gift_subscriptions SET starts_at = $2::timestamptz, expires_at = $2::timestamptz + interval '1 month' WHERE recipient_matrix_id = $1`, [who, oldEnd]);
    const c = await pool.connect();
    try { await realignQueuedGifts(c, who, SOURCES); await realignQueuedGifts(c, who, SOURCES); } finally { c.release(); } // the sweep, twice (a restart)
    assert.equal((await gifts(who))[0]!.follows, true, "the clock alone never starts a queued gift");
    // The renewal webhook lands late.
    const end2 = new Date(Date.now() + 29 * DAY);
    await observe(who, sub, { periodEnd: end2, at: new Date() });
    const [g] = await gifts(who);
    assert.ok(near(g!.start, end2), `re-dated behind the new term (got ${new Date(g!.start).toISOString()})`);
    await observe(who, sub, { periodEnd: end2, at: new Date() }); // its redelivery
    assert.ok(near((await gifts(who))[0]!.start, end2), "idempotent");
  });

  await t.test("cancelled at once (or Stripe gave up): a gift queued behind the old period end begins now", async () => {
    const { who, gifter, sub, session } = await fresh();
    await observe(who, sub, { periodEnd: new Date(Date.now() + 9 * DAY), at: new Date(Date.now() - 60_000) });
    await recorder().recordGift(gift(session, gifter, who));
    await observe(who, sub, { periodEnd: new Date(Date.now() + 9 * DAY), status: "ended", renews: false, at: new Date() });
    const [g] = await gifts(who);
    assert.ok(Math.abs(new Date(g!.start).getTime() - Date.now()) < 60_000, "no paid time left: the gift begins now, not at the old period end");
  });

  await t.test("a wrong start is undone: the record ends (Stripe gave up), the gift begins, then the card is paid after all", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 2 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 180_000) });
    await recorder().recordGift(gift(session, gifter, who));
    await observe(who, sub, { periodEnd: new Date(Date.now() - 3_600_000), status: "ended", renews: false, at: new Date(Date.now() - 120_000) });
    await pool.query(`UPDATE site.gift_subscriptions SET starts_at = now() - interval '1 hour', expires_at = now() - interval '1 hour' + interval '1 month' WHERE recipient_matrix_id = $1`, [who]);
    const end2 = new Date(Date.now() + 29 * DAY);
    await observe(who, sub, { periodEnd: end2, at: new Date() }); // paid: Stripe makes it active again
    assert.ok(near((await gifts(who))[0]!.start, end2), "the gift goes back behind the new term");
  });

  await t.test("a gift running when the viewer subscribes is never moved", async () => {
    const { who, gifter, sub, session } = await fresh();
    await recorder().recordGift(gift(session, gifter, who)); // no subscription: starts now
    const before = (await gifts(who))[0]!;
    assert.equal(before.follows, false);
    await observe(who, sub, { periodEnd: new Date(Date.now() + 30 * DAY), at: new Date() }); // e.g. PayPal, billed today
    assert.ok(near((await gifts(who))[0]!.expires_at, new Date(before.expires_at)));
  });

  await t.test("retry and restart: re-delivering the same transition, and the sweep run twice, change nothing more", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 4 * DAY), end2 = new Date(end1.getTime() + 30 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 60_000) });
    await recorder().recordGift(gift(session, gifter, who));
    const at = new Date();
    await observe(who, sub, { periodEnd: end2, at });
    const once = (await gifts(who))[0]!;
    await observe(who, sub, { periodEnd: end2, at }); // Stripe's redelivery
    const c = await pool.connect();
    try { await realignQueuedGifts(c, who, SOURCES); await realignQueuedGifts(c, who, SOURCES); } finally { c.release(); } // the sweep after a restart
    assert.deepEqual((await gifts(who))[0], once);
  });

  await t.test("migrate-v167: a gift already parked behind a renewing subscription is marked to follow it", async () => {
    const sql = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "migrations", "migrate-v167.sql"), "utf8");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS follows_subscription boolean NOT NULL DEFAULT false/);
    assert.match(sql, /INSERT INTO public\.schema_migrations \(version, note\)\s*VALUES \(167,/);
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date(Date.now() + 6 * DAY);
    await observe(who, sub, { periodEnd: end1, at: new Date() });
    // A gift dated by the old rule (start = the current period end), unflagged.
    await pool.query(
      `INSERT INTO site.gift_subscriptions (stripe_session_id, gifter_matrix_id, recipient_matrix_id, tier, months, kind, anonymous, starts_at, expires_at)
       VALUES ($1, $2, $3, 'supporter', 1, 'direct', false, $4::timestamptz, $4::timestamptz + interval '1 month')`, [session, gifter, who, end1]);
    const update = sql.slice(sql.indexOf("UPDATE site.gift_subscriptions"), sql.indexOf(";", sql.indexOf("UPDATE site.gift_subscriptions")) + 1);
    assert.ok(update.length > 20, "vacuity: the migration's UPDATE was found");
    // Inside a rolled-back transaction: the statement is table-wide, and other files' fixtures share it.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(update);
      const r = await c.query(`SELECT follows_subscription FROM site.gift_subscriptions WHERE recipient_matrix_id = $1`, [who]);
      assert.equal(r.rows[0]?.follows_subscription, true);
    } finally { await c.query("ROLLBACK"); c.release(); }
  });

  // CI 40250307555 (2026-10-26): the start was not stored but derived as `expires_at - months`, and
  // Postgres clamps month arithmetic (Oct 31 + 1 month = Nov 30; Nov 30 - 1 month = Oct 30): a gift
  // queued behind a period ending on the 31st told its recipient it began a day early. The start is
  // stored now (migrate-v172 `starts_at`), written by the grant and by the renewal mover. Fixed dates,
  // not now-relative: the 31st must be in the test, not in the calendar the test happens to run on.
  await t.test("month end: a gift queued behind a period ending on the 31st starts on the 31st, and the renewal mover moves the stored start", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date("2030-10-31T12:00:00Z"), end2 = new Date("2031-03-31T12:00:00Z");
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 60_000) });
    await recorder().recordGift(gift(session, gifter, who));
    let [g] = await gifts(who);
    assert.equal(g!.follows, true);
    assert.equal(new Date(g!.start).toISOString(), end1.toISOString(), "the stored start is the period end, exactly");
    assert.equal(new Date(g!.expires_at).toISOString(), "2030-11-30T12:00:00.000Z", "one month on, clamped at the END only");
    assert.equal(await queuedGiftStart(pool, who), end1.toISOString(), "the date the recipient is told");
    await observe(who, sub, { periodEnd: end2, at: new Date() });
    [g] = await gifts(who);
    assert.equal(new Date(g!.start).toISOString(), end2.toISOString(), "the renewal moved the stored start to the new period end");
    assert.equal(new Date(g!.expires_at).toISOString(), "2031-04-30T12:00:00.000Z");
    assert.equal(await queuedGiftStart(pool, who), end2.toISOString());
  });

  await t.test("retry and restart at a month end: the redelivered renewal and the sweep twice move nothing more", async () => {
    const { who, gifter, sub, session } = await fresh();
    const end1 = new Date("2030-10-31T12:00:00Z"), end2 = new Date("2031-03-31T12:00:00Z");
    await observe(who, sub, { periodEnd: end1, at: new Date(Date.now() - 60_000) });
    await recorder().recordGift(gift(session, gifter, who));
    const at = new Date();
    await observe(who, sub, { periodEnd: end2, at });
    const once = (await gifts(who))[0]!;
    await observe(who, sub, { periodEnd: end2, at }); // Stripe's redelivery
    const c = await pool.connect();
    let moved = 0;
    // A start derived from the end (Mar 30) differs from the period end and was "moved" on every pass.
    try { moved += await realignQueuedGifts(c, who, SOURCES); moved += await realignQueuedGifts(c, who, SOURCES); } finally { c.release(); }
    assert.equal(moved, 0, "the sweep after a restart finds the stored start already at the period end");
    assert.deepEqual((await gifts(who))[0], once);
    assert.equal(new Date(once.start).toISOString(), end2.toISOString());
  });

  await t.test("migrate-v172: the backfill gives each pre-v172 gift its real start where the rows still show it", async () => {
    const sql = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "migrations", "migrate-v172.sql"), "utf8");
    assert.match(sql, /ADD COLUMN IF NOT EXISTS starts_at timestamptz;/);
    assert.match(sql, /ALTER COLUMN starts_at SET NOT NULL;/);
    assert.match(sql, /INSERT INTO public\.schema_migrations \(version, note\)\s*VALUES \(172,/);
    const at = sql.indexOf("UPDATE site.gift_subscriptions");
    const update = sql.slice(at, sql.indexOf(";", at) + 1);
    assert.ok(at >= 0 && update.length > 20, "vacuity: the migration's UPDATE was found");
    const { who, gifter, session } = await fresh();
    // Gifts as the old grant wrote them, with no start stored. Inside a rolled-back transaction: the
    // statement is table-wide, and other files' fixtures share the table.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER TABLE site.gift_subscriptions ALTER COLUMN starts_at DROP NOT NULL`);
      const ins = async (s: string, created: string, expires: string, extra: { before?: string } = {}) => (await c.query<{ id: string }>(
        `INSERT INTO site.gift_subscriptions (stripe_session_id, gifter_matrix_id, recipient_matrix_id, months, created_at, expires_at, expires_before_reversal, reversed_at)
         VALUES ($1, $2, $3, 1, $4::timestamptz, $5::timestamptz, $6::timestamptz, CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE now() END) RETURNING id`,
        [s, gifter, who, created, expires, extra.before ?? null])).rows[0]!.id;
      const a = await ins(`${session}a`, "2030-09-30T12:00:00Z", "2030-10-31T12:00:00Z");  // created + 1 month = Oct 30: not its own grant time
      const b = await ins(`${session}b`, "2030-10-01T08:00:00Z", "2030-11-30T12:00:00Z");  // stacked behind a: Oct 31 + 1 month
      const d = await ins(`${session}d`, "2030-10-02T08:00:00Z", "2031-01-20T06:00:00Z");  // behind paid time: nothing in the rows
      const r = await ins(`${session}r`, "2030-10-03T08:00:00Z", "2030-10-05T00:00:00Z", { before: "2030-11-03T08:00:00Z" }); // reversed: its end was clipped
      await c.query(update);
      const got = Object.fromEntries((await c.query<{ id: string; starts_at: Date }>(
        `SELECT id, starts_at FROM site.gift_subscriptions WHERE recipient_matrix_id = $1`, [who])).rows.map((x) => [x.id, new Date(x.starts_at).toISOString()]));
      assert.equal(got[b], "2030-10-31T12:00:00.000Z", "stacked behind gift a: starts at a's end (the 31st), not the derived Oct 30");
      assert.equal(got[d], "2030-12-20T06:00:00.000Z", "behind paid time: the derivation, the best the rows hold");
      assert.equal(got[a], "2030-09-30T12:00:00.000Z", "derived from its end (Oct 31 - 1 month)");
      assert.equal(got[r], "2030-10-03T08:00:00.000Z", "a reversed gift is dated from its end before the reversal, not the clipped one");
      const e = (await c.query<{ id: string }>(
        `INSERT INTO site.gift_subscriptions (stripe_session_id, gifter_matrix_id, recipient_matrix_id, months, expires_at)
         VALUES ($1, $2, $3, 1, now() + interval '1 month') RETURNING id`, [`${session}e`, gifter, who])).rows[0]!.id;
      await c.query(update);
      const row = (await c.query<{ starts_at: Date; created_at: Date }>(`SELECT starts_at, created_at FROM site.gift_subscriptions WHERE id = $1`, [e])).rows[0]!;
      assert.equal(new Date(row.starts_at).getTime(), new Date(row.created_at).getTime(), "granted with nothing ahead: its start is its grant time, exactly");
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
});
