// v161's back-fill, and the readers moved onto the one entitlement fragment (subscription sources
// §3.5, §6, §13.1), on the REAL schema.
//
// Back-fill: fixture rows in site.subscriptions, one per Stripe status, go through the back-fill
// statement READ OUT OF migrate-v161.sql (not retyped here, so this cannot drift from what the
// migration runs), scoped to this run's viewers. Each becomes one record, its status mapped exactly
// as the TypeScript adapter maps it (stripeRecords.ts normaliseStripeStatus — the two copies held
// equal for every status), and a customer-pointer-only row becomes none.
//
// Readers: for those viewers plus gifts, each moved reader's NEW query (from the fragment) gives the
// same entitled set as its OLD query did (quoted from f9740396) — getActiveTier, the badge map, the
// badge re-point, badge equip, and account deletion's "still bills". Then switching the source off
// removes exactly its members. Staff are entitled by code (staff.ts), outside every query, unchanged.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/backfill.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { normaliseStripeStatus } from "./stripeRecords.ts";
import { ENTITLED_VIEWERS_SQL, VIEWER_TIERS_SQL, entitledRecordsSql, stillBills, viewerEntitledSql } from "./entitlement.ts";
import { highestTier } from "../tiers.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
// The migration history is the private repo's; a public tree starts from the baseline.
const MIGRATION = join(import.meta.dirname, "..", "..", "..", "..", "migrations", "migrate-v161.sql");
const skip = !existsSync(MIGRATION) ? "reads the migration history, which this tree does not carry"
  : unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `subfill${process.pid}x${Date.now().toString(36)}`;

/** The back-fill statement, as the migration has it, narrowed to this run's rows. */
function backfillSql(): string {
  const src = readFileSync(MIGRATION, "utf8");
  assert.match(src, /COMMIT;\s*$/, "END of migrate-v161.sql not read");
  const start = src.indexOf("INSERT INTO site.subscription_records");
  const end = src.indexOf("ON CONFLICT (provider, external_id) DO NOTHING;", start);
  assert.ok(start > 0 && end > start, "the back-fill statement is gone from migrate-v161.sql");
  const stmt = src.slice(start, end) + "ON CONFLICT (provider, external_id) DO NOTHING";
  const scoped = stmt.replace("WHERE s.stripe_sub_id IS NOT NULL", "WHERE s.stripe_sub_id IS NOT NULL AND s.matrix_id LIKE $1");
  assert.notEqual(scoped, stmt, "the back-fill's WHERE changed — re-check this test's scoping");
  return scoped;
}

// Every status Stripe has, plus a row with none.
const STATUSES = ["active", "trialing", "past_due", "incomplete", "incomplete_expired", "unpaid", "paused", "canceled", null] as const;

test("v161's back-fill and the readers moved onto the one fragment", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const like = `@${RUN}%`;
  const clean = async () => {
    await pool.query(`DELETE FROM site.gift_subscriptions WHERE recipient_matrix_id LIKE $1`, [like]);
    await pool.query(`DELETE FROM site.subscriptions WHERE matrix_id LIKE $1`, [like]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [like]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const viewers: { who: string; status: string | null; tier: string | null; cancel: boolean }[] = [];
  let n = 0;
  const add = async (status: string | null, tier: string | null, cancel = false, sub = true) => {
    const who = `@${RUN}-${++n}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    await pool.query(
      `INSERT INTO site.subscriptions (matrix_id, stripe_customer_id, stripe_sub_id, tier, status, current_period_end, cancel_at_period_end, updated_at, stripe_event_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '20 days', $6, now() - interval '1 day', CASE WHEN $7::boolean THEN now() - interval '2 days' END)`,
      [who, `cus_${RUN}_${n}`, sub ? `sub_${RUN}_${n}` : null, tier, status, cancel, n % 2 === 0]);
    viewers.push({ who, status, tier, cancel });
    return who;
  };
  for (const s of STATUSES) await add(s, s === "canceled" || s === "incomplete_expired" ? null : "supporter");
  await add("active", "supporter", true);           // renewal switched off
  await add("past_due", "supporter", true);
  const pointerOnly = await add(null, null, false, false); // a customer pointer, no subscription
  const noTier = await add("active", null);          // a price the install does not sell
  // Gifts: one on a subscriber, one on a non-subscriber, one expired.
  let g = 0;
  const gift = async (who: string, days: number) => pool.query(
    `INSERT INTO site.gift_subscriptions (recipient_matrix_id, gifter_matrix_id, months, expires_at, stripe_session_id)
     VALUES ($1, NULL, 1, now() + make_interval(days => $2), $3)`, [who, days, `cs_${RUN}_${++g}`]);
  await gift(viewers[0]!.who, 10);
  await gift(viewers[7]!.who, 10);  // canceled + gift
  await gift(viewers[3]!.who, -1);  // incomplete + an expired gift

  await t.test("one record per subscription row, status mapped as the adapter maps it, idempotent", async () => {
    const sql = backfillSql();
    const first = await pool.query(sql, [like]);
    assert.equal(first.rowCount, viewers.length - 1, "every row that names a subscription, and only those");
    assert.equal((await pool.query(sql, [like])).rowCount, 0, "a second run writes nothing");
    const recs = (await pool.query(
      `SELECT matrix_id, provider, status, provider_status, tier, renews, account_ref, source_event_at, access_until
         FROM site.subscription_records WHERE matrix_id LIKE $1`, [like])).rows;
    const legacy = new Map((await pool.query(`SELECT * FROM site.subscriptions WHERE matrix_id LIKE $1`, [like])).rows.map((r) => [r.matrix_id, r]));
    assert.equal(recs.length, viewers.length - 1);
    assert.ok(!recs.some((r) => r.matrix_id === pointerOnly), "a customer pointer alone is not a subscription");
    for (const r of recs) {
      const l = legacy.get(r.matrix_id)!;
      assert.equal(r.provider, "stripe");
      assert.equal(r.status, normaliseStripeStatus(l.status), `status ${l.status}: the migration and the adapter disagree`);
      assert.equal(r.provider_status, l.status ?? "unknown");
      assert.equal(r.tier, l.tier);
      assert.equal(r.renews, !l.cancel_at_period_end);
      assert.equal(r.account_ref, l.stripe_customer_id);
      assert.equal(r.access_until, null, "Stripe: status alone decides");
      assert.equal(new Date(r.source_event_at).getTime(), new Date(l.stripe_event_at ?? l.updated_at).getTime());
    }
  });

  const SOURCES = ["stripe", "paypal"];
  const mine = (rows: { matrix_id?: string; mid?: string }[]) => rows.map((r) => (r.matrix_id ?? r.mid)!).filter((m) => m.startsWith(`@${RUN}`)).sort();

  await t.test("the badge map and the badge re-point: the same entitled set as before", async () => {
    // OLD (badgeCache.ts / billingServer.ts at f9740396) vs NEW (the fragment).
    const oldSubs = mine((await pool.query(`SELECT matrix_id FROM site.subscriptions WHERE status IN ('active','trialing','past_due') AND matrix_id IS NOT NULL`)).rows);
    const newSubs = mine((await pool.query(ENTITLED_VIEWERS_SQL, [SOURCES])).rows);
    // The ONE intended difference: an active subscription at a price the install does not sell
    // (tier NULL). getActiveTier never counted it; the badge map did. The fragment takes
    // getActiveTier's answer, so every reader now agrees.
    assert.deepEqual(newSubs, oldSubs.filter((m) => m !== noTier));
    assert.ok(oldSubs.includes(noTier));
    const oldRepoint = mine((await pool.query(`SELECT matrix_id AS mid FROM site.subscriptions WHERE status IN ('active','trialing','past_due') AND matrix_id IS NOT NULL
      UNION SELECT recipient_matrix_id FROM site.gift_subscriptions WHERE expires_at > now()`)).rows);
    const newRepoint = mine((await pool.query(`SELECT r.matrix_id AS mid FROM site.subscription_records r WHERE ${entitledRecordsSql("r", "$1")}
      UNION SELECT recipient_matrix_id FROM site.gift_subscriptions WHERE expires_at > now()`, [SOURCES])).rows);
    assert.deepEqual(newRepoint, oldRepoint.filter((m) => m !== noTier));
    assert.ok(newSubs.length >= 4, "vacuity: the fixture has entitled viewers");
  });

  await t.test("getActiveTier, badge equip and deletion's still-bills: the same answer per viewer as before", async () => {
    for (const { who, status } of viewers) {
      // getActiveTier at f9740396: an active status → the row's tier, else a live gift → supporter.
      const o = (await pool.query(`SELECT s.tier AS sub_tier, s.status AS sub_status,
          EXISTS (SELECT 1 FROM site.gift_subscriptions g WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()) AS gift_active
        FROM (SELECT $1::text AS mid) m LEFT JOIN site.subscriptions s ON s.matrix_id = m.mid`, [who])).rows[0];
      const oldTier = ["active", "trialing", "past_due"].includes(o.sub_status) ? o.sub_tier : o.gift_active ? "supporter" : null;
      const nw = (await pool.query(`SELECT ARRAY(${VIEWER_TIERS_SQL}) AS sub_tiers,
          EXISTS (SELECT 1 FROM site.gift_subscriptions g WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()) AS gift_active`, [who, SOURCES])).rows[0];
      const newTier = highestTier(nw.sub_tiers) ?? (nw.gift_active ? "supporter" : null);
      assert.equal(newTier, oldTier, `getActiveTier for ${status}`);

      // Badge equip's `entitled`.
      const oldEquip = (await pool.query(`SELECT ( EXISTS (SELECT 1 FROM site.subscriptions s WHERE s.matrix_id = $1 AND s.status IN ('active','trialing','past_due'))
        OR EXISTS (SELECT 1 FROM site.gift_subscriptions g WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()) ) AS e`, [who])).rows[0].e;
      const newEquip = (await pool.query(`SELECT ( ${viewerEntitledSql("$1", "$2")}
        OR EXISTS (SELECT 1 FROM site.gift_subscriptions g WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()) ) AS e`, [who, SOURCES])).rows[0].e;
      assert.equal(newEquip, who === noTier ? false : oldEquip, `equip for ${status}`);

      // Account deletion's block, at f9740396: the row's status in this list and renewal not off.
      const l = (await pool.query(`SELECT status, cancel_at_period_end FROM site.subscriptions WHERE matrix_id = $1`, [who])).rows;
      const oldBills = l.some((s) => ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(s.status) && s.cancel_at_period_end !== true);
      // NEW adds Stripe `paused` (a paused subscription resumes and charges again — still the site's).
      const want = status === "paused" ? true : oldBills;
      assert.equal(await stillBills(pool, who), want, `still bills for ${status}`);
    }
  });

  await t.test("switching the source off removes exactly its members; back on restores them", async () => {
    const on = mine((await pool.query(ENTITLED_VIEWERS_SQL, [SOURCES])).rows);
    const off = mine((await pool.query(ENTITLED_VIEWERS_SQL, [["paypal"]])).rows);
    const back = mine((await pool.query(ENTITLED_VIEWERS_SQL, [SOURCES])).rows);
    assert.ok(on.length > 0);
    assert.deepEqual(off, []);
    assert.deepEqual(back, on);
  });
});
