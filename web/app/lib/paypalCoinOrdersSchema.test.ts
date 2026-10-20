// site.paypal_coin_orders on the REAL schema (replayed migrations). A mock pool
// cannot tell us the table exists, that status is constrained, or that
// capture_id is unique — Postgres can. It also runs a full order → capture →
// refund through the real code.
// Runs in CI (web job sets SQL_PARSE_DATABASE_URL to a replayed pg18).
// Locally: see donationsSchema.test.ts for the sandbox-db recipe.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway database (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);

test("site.paypal_coin_orders on the real schema", { skip: unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL });
  const tag = `coinorders-test-${process.pid}`;
  const clean = () => pool.query(`DELETE FROM site.paypal_coin_orders WHERE external_id LIKE $1`, [`${tag}%`]);
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await t.test("the columns v125 promised exist", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'site' AND table_name = 'paypal_coin_orders'`,
    );
    const have = new Set(rows.map((r) => r.column_name));
    for (const c of ["external_id", "matrix_id", "amount_cents", "status", "capture_id", "created_at", "completed_at"]) {
      assert.ok(have.has(c), `site.paypal_coin_orders.${c} missing — migrate-v125.sql not applied here`);
    }
  });

  await t.test("a new row starts pending", async () => {
    await pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents) VALUES ($1, '@a:x', 500)`, [`${tag}-1`]);
    const { rows } = await pool.query(`SELECT status FROM site.paypal_coin_orders WHERE external_id = $1`, [`${tag}-1`]);
    assert.equal(rows[0].status, "pending");
  });

  await t.test("status is constrained, amount must be positive, capture_id is unique", async () => {
    await assert.rejects(pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents, status) VALUES ($1, '@a:x', 500, 'bogus')`, [`${tag}-2`]));
    await assert.rejects(pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents) VALUES ($1, '@a:x', 0)`, [`${tag}-3`]));
    await pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents, capture_id) VALUES ($1, '@a:x', 500, $2)`, [`${tag}-4`, `${tag}-CAP`]);
    await assert.rejects(pool.query(`INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents, capture_id) VALUES ($1, '@a:x', 500, $2)`, [`${tag}-5`, `${tag}-CAP`]));
  });

  await t.test("schema_migrations records v125", async () => {
    const { rows } = await pool.query(`SELECT 1 FROM public.schema_migrations WHERE version = 125`);
    assert.equal(rows.length, 1);
  });

  await t.test("order → capture (twice) → refund, through the REAL code on the real schema", async () => {
    const { createPointsOrders } = await import("./paypalPointsOrder.ts");
    const { createPaypalWebhookHandlers } = await import("./paypalWebhookHandlers.ts");
    const { createMoneyCredits } = await import("./coinsServer.ts");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const who = `@${tag}:test`;
    // site.payment_events.matrix_id REFERENCES site.users(matrix_id) — a
    // throwaway row for the test buyer so onCaptureRefunded's payment_events
    // INSERT doesn't violate that FK; cleaned up in the finally below.
    //
    // Cleanup runs inline in a finally, NOT via t.after: this subtest's arrow
    // takes no `t` of its own, so a `t.after` call here closes over the
    // OUTER test's `t` and appends to the SAME hook list the outer test
    // registered its own `clean(); pool.end()` hook on at setup — and node's
    // test runner runs after-hooks in REGISTRATION order, not LIFO. That
    // earlier hook closes the pool before a later-registered one here would
    // run, so any pool query in it throws "Cannot use a pool after calling
    // end on the pool". A plain try/finally has no such ordering hazard.
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    try {
      let customId = "";
      const qo = createPointsOrders({ pool, createPaypalOrder: (async (a: { customId: string }) => { customId = a.customId; return { orderId: "O" }; }) as never });
      await qo.open({ matrixId: who, cents: 500 });
      const credits = createMoneyCredits({ pool });
      const h = createPaypalWebhookHandlers({ pool, credits });
      const fx = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "paypal", `${n}.json`), "utf8"));
      const cap = fx("payment.capture.completed");
      cap.resource.id = `${tag}CAP`;
      cap.resource.custom_id = customId;
      cap.resource.amount.value = "5.00";
      const bal = async () => Number((await pool.query(`SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`, [who])).rows[0]?.balance ?? 0);
      await h.onCaptureCompleted(cap);
      await h.onCaptureCompleted(cap); // redelivery
      assert.equal(await bal(), 500);
      const o = await pool.query(`SELECT status, capture_id FROM site.paypal_coin_orders WHERE matrix_id = $1`, [who]);
      assert.deepEqual(o.rows[0], { status: "completed", capture_id: `${tag}CAP` });
      const d = await pool.query(`SELECT 1 FROM site.donations WHERE provider_ref = $1`, [`${tag}CAP`]);
      assert.equal(d.rows.length, 0, "a Qorm purchase must never become a donations row");
      const ref = fx("payment.capture.refunded");
      ref.id = `WH-${tag}`;
      ref.resource.id = `${tag}REF`;
      ref.resource.amount.value = "5.00";
      ref.resource.links = [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${tag}CAP`, method: "GET" }];
      await h.onCaptureRefunded(ref);
      assert.equal(await bal(), 0);
      const ev = await pool.query(`SELECT kind FROM site.payment_events WHERE matrix_id = $1`, [who]);
      assert.equal(ev.rows[0]?.kind, "coin_purchase");
    } finally {
      await pool.query(`DELETE FROM site.coin_ledger WHERE matrix_id = $1`, [who]);
      await pool.query(`DELETE FROM site.coin_wallets WHERE matrix_id = $1`, [who]);
      await pool.query(`DELETE FROM site.payment_events WHERE matrix_id = $1`, [who]);
      await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    }
  });
});
