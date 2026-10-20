// web/app/lib/paymentResultServer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPaymentResultServer } from "./paymentResultServer.ts";

type Row = Record<string, unknown>;
function fakePool(rows: Row[]) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = { query: async (sql: string, params: unknown[] = []) => { seen.push({ sql, params }); return { rows, rowCount: rows.length }; } };
  return { pool: pool as never, seen };
}

test("no matching row -> null", async () => {
  assert.equal(await createPaymentResultServer({ pool: fakePool([]).pool }).latestFailedResult("cs_1", new Date(0)), null);
});

test("a matching row -> title/canRetry recomputed, body is the cached reason_text", async () => {
  const { pool, seen } = fakePool([{
    reason_code: "insufficient_funds", decline_code: null,
    reason_text: "Insufficient funds. You were not charged. Try another payment method or card.",
    occurred_at: new Date("2026-09-22T01:00:00Z"),
  }]);
  const r = await createPaymentResultServer({ pool }).latestFailedResult("cs_1", new Date(0));
  assert.deepEqual(r, {
    title: "Insufficient funds.",
    body: "Insufficient funds. You were not charged. Try another payment method or card.",
    canRetry: true, at: "2026-09-22T01:00:00.000Z",
  });
  assert.match(seen[0]!.sql, /WHERE session_id = \$1 AND outcome = 'failed' AND occurred_at > \$2/);
  assert.deepEqual(seen[0]!.params, ["cs_1", new Date(0)]);
});
