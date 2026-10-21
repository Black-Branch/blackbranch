// Account deletion and subscription records (subscription sources §9, D23, D31), on the REAL schema
// through eraseSiteData itself.
//
// A viewer holding one record of every service: the records of services the site does NOT bill
// (Patreon, Ko-fi, Twitch, Kick) are deleted with their payments and their events; the Stripe and
// PayPal ones stay on the tombstone, with theirs; membership links, PayPal intents and Ko-fi claims
// are gone. Another viewer's rows are untouched. The mutation the spec names — keep a Patreon record
// — fails the first assertion below (BILLED_PROVIDERS gaining 'patreon' was tried; recorded in the
// S1 report).
// Then the inbox's body expiry (§3.1): 31 days old and failed → body cleared and marked; 29 days old
// keeps it.
// Locally: SQL_PARSE_DATABASE_URL=… node --test app/lib/subscriptions/deletion.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { eraseSiteData } from "../accountDeletion.ts";
import { clearExpiredBodies } from "./inbox.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

const RUN = `subdel${process.pid}x${Date.now().toString(36)}`;
const PROVIDERS = ["stripe", "paypal", "patreon", "kofi", "twitch", "kick"] as const;

test("a deletion erases the records of services the site does not bill, and keeps the billed ones", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const me = `@${RUN}-me:site.test`, other = `@${RUN}-other:site.test`;
  const clean = async () => {
    await pool.query(`DELETE FROM site.subscription_events WHERE event_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.subscription_records WHERE external_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    // The intent ids are fixed: a run that died before its own clean-up must not block this one.
    await pool.query(`DELETE FROM site.subscription_intents WHERE id = ANY($1::text[])`, [[`si_${"M".repeat(22)}`, `si_${"O".repeat(22)}`]]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2)`, [me, other]);
  for (const who of [me, other]) {
    for (const p of PROVIDERS) {
      const ext = `${RUN}_${who === me ? "me" : "other"}_${p}`;
      // Fixture rows written directly: this test is about what the erase removes, not how a record
      // is made (state.test.ts).
      // The PayPal one is cancelled-in-period (renews false): a live one would be cancelled at PayPal
      // by the erase (paypal.test.ts covers that), and this test makes no network call.
      const id = (await pool.query(`INSERT INTO site.subscription_records (provider, external_id, matrix_id, tier, status, provider_status, source_event_at, renews)
        VALUES ($1, $2, $3, 'supporter', 'active', 'x', now(), $4) RETURNING id`, [p, ext, who, p !== "paypal"])).rows[0].id;
      await pool.query(`INSERT INTO site.subscription_payments (provider, payment_id, record_id, amount_cents, currency, paid_at) VALUES ($1, $2, $3, 500, 'usd', now())`, [p, `${ext}_pay`, id]);
      await pool.query(`INSERT INTO site.subscription_events (provider, event_id, event_type, external_id, body) VALUES ($1, $2, 'x', $3, '{"name":"someone"}')`, [p, `${ext}_evt`, ext]);
    }
    await pool.query(`INSERT INTO site.subscription_accounts (provider, provider_user_id, matrix_id, linked_via) VALUES ('patreon', $1, $2, 'oauth')`, [`${RUN}_${who}`, who]);
    await pool.query(`INSERT INTO site.subscription_intents (id, matrix_id, provider, tier, plan_id) VALUES ($1, $2, 'paypal', 'supporter', 'P-1')`,
      [`si_${(who === me ? "M" : "O").repeat(22)}`, who]);
    await pool.query(`INSERT INTO site.subscription_claims (matrix_id, kind, email_hmac, typed_email, expires_at) VALUES ($1, 'email', 'h', 'typed@example.test', now() + interval '7 days')`, [who]);
  }

  const providersOf = async (who: string) =>
    (await pool.query(`SELECT provider FROM site.subscription_records WHERE matrix_id = $1 ORDER BY provider`, [who])).rows.map((r) => r.provider);
  const count = async (sql: string, who: string) => (await pool.query(sql, [who])).rows[0].n as number;

  const client = await pool.connect();
  let n: Record<string, number>;
  try {
    await client.query("BEGIN");
    n = await eraseSiteData(client, me);
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  assert.deepEqual(await providersOf(me), ["paypal", "stripe"], "only the records of services the site bills stay on the tombstone");
  assert.equal(n.subscriptionRecords, 4);
  assert.equal(await count(`SELECT count(*)::int AS n FROM site.subscription_payments p JOIN site.subscription_records r ON r.id = p.record_id WHERE r.matrix_id = $1`, me), 2,
    "the kept records keep their payments");
  const events = (await pool.query(`SELECT provider FROM site.subscription_events WHERE event_id LIKE $1 ORDER BY provider`, [`${RUN}_me_%`])).rows.map((r) => r.provider);
  assert.deepEqual(events, ["paypal", "stripe"], "the erased records' events (bodies included) are gone; the kept ones' stay");
  assert.equal(n.subscriptionPayments, 4);
  assert.equal(n.subscriptionEvents, 4);
  for (const tbl of ["subscription_accounts", "subscription_intents", "subscription_claims"]) {
    assert.equal(await count(`SELECT count(*)::int AS n FROM site.${tbl} WHERE matrix_id = $1`, me), 0, `site.${tbl} still holds their rows`);
  }
  // Nobody else touched.
  assert.deepEqual(await providersOf(other), [...PROVIDERS].sort());
  for (const tbl of ["subscription_accounts", "subscription_intents", "subscription_claims"]) {
    assert.equal(await count(`SELECT count(*)::int AS n FROM site.${tbl} WHERE matrix_id = $1`, other), 1, `someone else's site.${tbl} row was removed`);
  }
  assert.equal(await count(`SELECT count(*)::int AS n FROM site.subscription_events WHERE event_id LIKE $1`, `${RUN}_other_%`), 6);
});

test("inbox bodies expire after 30 days whatever the outcome; a younger body stays", { skip }, async (t) => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 1 });
  const clean = () => pool.query(`DELETE FROM site.subscription_events WHERE event_id LIKE $1`, [`${RUN}%`]);
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const row = (id: string, days: number, outcome: string | null) => pool.query(
    `INSERT INTO site.subscription_events (provider, event_id, event_type, received_at, body, outcome)
     VALUES ('kofi', $1, 'Subscription', now() - make_interval(days => $2), '{"email":"someone@example.test"}', $3)`, [id, days, outcome]);
  await row(`${RUN}_old_failed`, 31, "failed:no tier map");
  await row(`${RUN}_old_open`, 31, null);
  await row(`${RUN}_young_failed`, 29, "failed:no tier map");
  const cleared = await clearExpiredBodies(pool);
  assert.ok(cleared >= 2);
  const got = Object.fromEntries((await pool.query(`SELECT event_id, body IS NULL AS gone, outcome FROM site.subscription_events WHERE event_id LIKE $1`, [`${RUN}%`]))
    .rows.map((r) => [String(r.event_id).slice(RUN.length + 1), [r.gone, r.outcome]]));
  assert.deepEqual(got, {
    old_failed: [true, "failed:no tier map; body expired"],
    old_open: [true, "failed:not applied; body expired"],
    young_failed: [false, "failed:no tier map"],
  });
  assert.equal(await clearExpiredBodies(pool).then((x) => x >= 0), true);
  const again = (await pool.query(`SELECT outcome FROM site.subscription_events WHERE event_id = $1`, [`${RUN}_old_failed`])).rows[0].outcome;
  assert.equal(again, "failed:no tier map; body expired", "a second sweep does not mark it twice");
});
