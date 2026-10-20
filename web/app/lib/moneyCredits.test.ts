import { test } from "node:test";
import assert from "node:assert/strict";
import { createMoneyCredits } from "./coinsServer.ts";

type Row = Record<string, unknown>;

/** Fake pool answering by SQL pattern rather than call order, so a test does
 *  not break when an unrelated statement is added — the shape storePricingServer.test.ts shares. */
function fakePool(
  handlers: Array<[RegExp, (p: unknown[]) => { rows: Row[]; rowCount: number }]>,
  onConnect?: () => void
) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    seen,
    pool: { connect: async () => { onConnect?.(); return client; }, query: client.query } as never,
  };
}

const CREDITED = /SUM\(delta\) AS credited/;
const ROW_LOCK = /FROM site\.coin_wallets WHERE matrix_id = \$1 FOR UPDATE/;
const TAKEN = /AS taken/;
const CREDIT_INS = /INSERT INTO site\.coin_ledger/;
const WALLET_UPSERT = /INSERT INTO site\.coin_wallets/;

// ── recordTipCredit: cents <= 0 is a no-op ──────────────────────────────────

test("recordTipCredit issues no query when cents is 0 or negative", async () => {
  for (const cents of [0, -5]) {
    const { pool, seen } = fakePool([]);
    const credits = createMoneyCredits({ pool });
    await credits.recordTipCredit({
      matrixId: "@a:x", cents, ref: `stripe:cs_${cents}`,
      payment: { provider: "stripe", paymentIntent: "pi_1" },
    });
    assert.equal(seen.length, 0, `cents=${cents} must not touch the pool at all`);
  }
});

// ── clawbackForPayment: the wallet UPDATE deliberately has no balance guard ─

test("the clawback's wallet update carries no `balance >=` predicate — a spent wallet must go negative", async () => {
  const { pool, seen } = fakePool([
    [CREDITED, () => ({ rows: [{ matrix_id: "@a:x", credited: "500" }], rowCount: 1 })],
    [ROW_LOCK, () => ({ rows: [{ }], rowCount: 1 })],
    [TAKEN, () => ({ rows: [{ taken: "0" }], rowCount: 1 })],
    [CREDIT_INS, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET_UPSERT, () => ({ rows: [{ balance: "-200" }], rowCount: 1 })],
  ]);
  const credits = createMoneyCredits({ pool });
  await credits.clawbackForPayment({
    payment: { provider: "stripe", paymentIntent: "pi_1" },
    cents: 200, ref: "stripe:refund:re_1", reason: "refund",
  });

  const walletUpdate = seen.find((q) => WALLET_UPSERT.test(q.sql));
  // Vacuity anchor: the assertion below is meaningless if the UPDATE never ran.
  assert.ok(walletUpdate, "expected the clawback to write the wallet");
  assert.doesNotMatch(walletUpdate.sql, /balance\s*>=/,
    "debitCoins' guard belongs to spends only — a clawback must be able to take a wallet below zero");
});

// ── recordPurchaseCredit (Piece 2): kind 'purchase', meta keyed like a tip ──

test("recordPurchaseCredit issues no query when cents is 0 or negative", async () => {
  for (const cents of [0, -5]) {
    const { pool, seen } = fakePool([]);
    const credits = createMoneyCredits({ pool });
    await credits.recordPurchaseCredit({
      matrixId: "@a:x", cents, ref: `paypal:CAP${cents}`,
      payment: { provider: "paypal", captureId: "CAP" },
    });
    assert.equal(seen.length, 0, `cents=${cents} must not touch the pool at all`);
  }
});

test("recordPurchaseCredit writes kind 'purchase' with the capture id in meta — the key a PayPal refund claws back by", async () => {
  const { pool, seen } = fakePool([
    [CREDIT_INS, () => ({ rows: [{ id: 1 }], rowCount: 1 })],
    [WALLET_UPSERT, () => ({ rows: [{ balance: "500" }], rowCount: 1 })],
  ]);
  const credits = createMoneyCredits({ pool });
  await credits.recordPurchaseCredit({
    matrixId: "@a:x", cents: 500, ref: "paypal:CAP1",
    payment: { provider: "paypal", captureId: "CAP1" },
  });
  const ins = seen.find((q) => CREDIT_INS.test(q.sql));
  assert.ok(ins, "no ledger insert ran");
  assert.ok(ins!.params.includes("purchase"), `kind must be 'purchase', params were ${JSON.stringify(ins!.params)}`);
  assert.ok(ins!.params.includes("paypal:CAP1"));
  const meta = ins!.params.find((p) => typeof p === "string" && p.startsWith("{"));
  assert.deepEqual(JSON.parse(String(meta)), { capture_id: "CAP1" });
});
