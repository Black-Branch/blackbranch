// Behaviour of the money-credit writer on the REAL schema (replayed migrations),
// because every property here is SQL: the (kind, ref) unique index, a jsonb
// meta lookup, and a wallet UPDATE with no balance guard. A mock pool cannot
// reject any of them (feedback: a mock pool cannot reject illegal SQL).
// Runs in CI (web job sets SQL_PARSE_DATABASE_URL to a replayed pg18).
// Locally: see donationsSchema.test.ts for the sandbox-db recipe.
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { createMoneyCredits } from "./coinsServer.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);

test("money credits on the real schema", { skip: unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL });
  const credits = createMoneyCredits({ pool });
  const who = `@moneycredits-test-${process.pid}:test`;
  const pi = `pi_test_${process.pid}`;
  const balance = async () =>
    Number((await pool.query(`SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`, [who])).rows[0]?.balance ?? 0);
  const clean = () => Promise.all([
    pool.query(`DELETE FROM site.coin_ledger WHERE matrix_id = $1`, [who]),
    pool.query(`DELETE FROM site.coin_wallets WHERE matrix_id = $1`, [who]),
    // The fixed refs below leave payment_reversals rows (v149) that a rerun on the
    // same database would otherwise read as already settled. Exact refs only:
    // other test files share this database and run in parallel.
    pool.query(`DELETE FROM site.payment_reversals WHERE ref = ANY($1)`, [[
      "stripe:refund:re_1", "stripe:refund:re_2", "stripe:refund:re_3", "stripe:refund:re_x",
      "stripe:dispute:dp_1", "stripe:dispute:dp_3", "stripe:dispute:dp_never",
      `paypal:refund:R${process.pid}`, "paypal:refund:R1",
    ]]),
  ]);
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const payment = { provider: "stripe", paymentIntent: pi } as const;

  await t.test("a tip credits once, even when delivered twice", async () => {
    await credits.recordTipCredit({ matrixId: who, cents: 500, ref: "stripe:cs_1", payment });
    await credits.recordTipCredit({ matrixId: who, cents: 500, ref: "stripe:cs_1", payment });
    assert.equal(await balance(), 500);
  });

  await t.test("two partial refunds take back their own amounts", async () => {
    await credits.clawbackForPayment({ payment, cents: 200, ref: "stripe:refund:re_1", reason: "refund" });
    await credits.clawbackForPayment({ payment, cents: 200, ref: "stripe:refund:re_1", reason: "refund" }); // redelivery
    await credits.clawbackForPayment({ payment, cents: 100, ref: "stripe:refund:re_2", reason: "refund" });
    assert.equal(await balance(), 200);
  });

  await t.test("a dispute takes back only what is left of the payment — never more than was credited", async () => {
    await credits.clawbackForPayment({ payment, cents: 500, ref: "stripe:dispute:dp_1", reason: "dispute" });
    assert.equal(await balance(), 0); // 500 credited, 300 already back, so 200 more
  });

  await t.test("a clawback goes below zero when the Qorm was already spent", async () => {
    const pi2 = { provider: "stripe", paymentIntent: `${pi}_2` } as const;
    await credits.recordTipCredit({ matrixId: who, cents: 300, ref: "stripe:cs_2", payment: pi2 });
    // Simulate a spend as debitCoins writes one — ledger row AND wallet, so the
    // reconciliation check below stays meaningful. (debitCoins itself is bound
    // to the module pool = production, so it is never called from here.)
    await pool.query(`INSERT INTO site.coin_ledger (matrix_id, delta, kind, sink, ref) VALUES ($1, -300, 'spend', 'sticker', $2)`, [who, `spend-test-${process.pid}`]);
    await pool.query(`UPDATE site.coin_wallets SET balance = balance - 300 WHERE matrix_id = $1`, [who]);
    await credits.clawbackForPayment({ payment: pi2, cents: 300, ref: "stripe:refund:re_3", reason: "refund" });
    assert.equal(await balance(), -300);
  });

  await t.test("a won dispute restores exactly its clawback, once", async () => {
    await credits.restoreClawback({ clawbackRef: "stripe:dispute:dp_1", ref: "stripe:dispute-won:dp_1" });
    await credits.restoreClawback({ clawbackRef: "stripe:dispute:dp_1", ref: "stripe:dispute-won:dp_1" });
    assert.equal(await balance(), -100);
  });

  // Proves the "left" calculation nets `clawback_reversed` against `clawback`
  // (coinsServer.ts's clawbackForPayment: `taken = SUM(delta) WHERE kind IN
  // ('clawback', 'clawback_reversed')`), not just `clawback` alone. The
  // restore above put 200 back into what is still held for `payment`
  // (pi_test_<pid>) — clawing it back again, under a fresh ref, must take
  // exactly that 200 back out. Deleting 'clawback_reversed' from that IN
  // clause turns this red: `left` would then still read 0 (500 credited,
  // 500 already taken by re_1+re_2+dp_1, the restore never counted), so this
  // clawback would take nothing and the balance would not move. Verified by
  // hand: temporarily edited the SQL to drop 'clawback_reversed', re-ran this
  // file, saw exactly this assertion fail, then reverted.
  await t.test("clawing back the same payment again takes exactly what the restore gave back", async () => {
    const before = await balance();
    await credits.clawbackForPayment({ payment, cents: 200, ref: "stripe:dispute:dp_3", reason: "dispute" });
    assert.equal(await balance(), before - 200);
  });

  await t.test("a refund for a payment that gave no Qorm writes nothing", async () => {
    const before = (await pool.query(`SELECT count(*)::int n FROM site.coin_ledger WHERE matrix_id = $1`, [who])).rows[0].n;
    await credits.clawbackForPayment({ payment: { provider: "stripe", paymentIntent: "pi_never_credited" }, cents: 500, ref: "stripe:refund:re_x", reason: "refund" });
    await credits.restoreClawback({ clawbackRef: "stripe:dispute:dp_never", ref: "stripe:dispute-won:dp_never" });
    const after = (await pool.query(`SELECT count(*)::int n FROM site.coin_ledger WHERE matrix_id = $1`, [who])).rows[0].n;
    assert.equal(after, before);
  });

  await t.test("a PayPal purchase credits once and its refund takes it back", async () => {
    const before = await balance();
    const cap = { provider: "paypal", captureId: `CAPTEST${process.pid}` } as const;
    await credits.recordPurchaseCredit({ matrixId: who, cents: 400, ref: `paypal:${cap.captureId}`, payment: cap });
    await credits.recordPurchaseCredit({ matrixId: who, cents: 400, ref: `paypal:${cap.captureId}`, payment: cap }); // redelivery
    assert.equal(await balance(), before + 400);
    await credits.clawbackForPayment({ payment: cap, cents: 400, ref: `paypal:refund:R${process.pid}`, reason: "refund" });
    assert.equal(await balance(), before);
  });

  await t.test("the ledger still reconciles to the wallet", async () => {
    const sum = Number((await pool.query(`SELECT COALESCE(SUM(delta),0) s FROM site.coin_ledger WHERE matrix_id = $1`, [who])).rows[0].s);
    assert.equal(sum, await balance());
  });

  await t.test("a PayPal credit is found by its capture id", async () => {
    const pp = { provider: "paypal", captureId: `CAP${process.pid}` } as const;
    const b0 = await balance();
    await credits.recordTipCredit({ matrixId: who, cents: 100, ref: `paypal:${pp.captureId}`, payment: pp });
    await credits.clawbackForPayment({ payment: pp, cents: 100, ref: "paypal:refund:R1", reason: "refund" });
    assert.equal(await balance(), b0);
  });
});
