// paypalPointsOrder.ts — driven for real with a fake pool and a fake
// createPaypalOrder (no database, no PayPal).
// Run: systemd-run --user --scope -p MemoryMax=8G --quiet node --test app/lib/paypalPointsOrder.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createPointsOrders, orderPurpose, pointsOrderKey } from "./paypalPointsOrder.ts";

function fakes(opts: { orderFails?: boolean } = {}) {
  const order: string[] = [];
  const sql: Array<{ sql: string; params: unknown[] }> = [];
  const orders: Array<{ amountUsd: number; customId: string }> = [];
  const pool = {
    query: async (s: string, params: unknown[] = []) => { order.push("insert"); sql.push({ sql: s, params }); return { rows: [], rowCount: 1 }; },
  };
  const createPaypalOrder = async (a: { amountUsd: number; customId: string }) => {
    order.push("paypal"); orders.push(a);
    if (opts.orderFails) throw new Error("paypal create order: 500");
    return { orderId: "ORDER1" };
  };
  return { order, sql, orders, qo: createPointsOrders({ pool: pool as never, createPaypalOrder }) };
}

test("pointsOrderKey reads the points: prefix only; the retired prefix and a tip's bare uuid are not purchases", () => {
  assert.equal(pointsOrderKey("points:abc"), "abc");
  assert.equal(pointsOrderKey("qorm:abc"), null, "the pre-phase-R prefix is no longer read (R contract step)");
  assert.equal(pointsOrderKey("d93e4fcb-d3af-137c-82fe-1a8101f1ad11"), null);
  assert.equal(pointsOrderKey("pointsabc"), null);
  assert.equal(pointsOrderKey(""), null);
});

test("parks a pending row in paypal_coin_orders BEFORE asking PayPal, and never touches donations", async () => {
  const f = fakes();
  const r = await f.qo.open({ matrixId: "@a:x", cents: 500 });
  assert.deepEqual(r, { orderId: "ORDER1" });
  assert.deepEqual(f.order, ["insert", "paypal"]);
  assert.equal(f.sql.length, 1);
  assert.match(f.sql[0]!.sql, /INSERT INTO site\.paypal_coin_orders/);
  assert.doesNotMatch(f.sql[0]!.sql, /donations/);
  const [externalId, matrixId, cents] = f.sql[0]!.params;
  assert.equal(matrixId, "@a:x");
  assert.equal(cents, 500);
  assert.match(String(externalId), /^[0-9a-f-]{36}$/);
  assert.equal(f.orders[0]!.customId, `points:${externalId}`, "custom_id must be the prefix + the row's own key");
  assert.equal(f.orders[0]!.amountUsd, 5);
  assert.ok(f.orders[0]!.customId.length <= 127, "PayPal caps custom_id at 127 chars");
});

test("the pressed button reaches PayPal: open() hands its fundingSource to createPaypalOrder", async () => {
  const f = fakes();
  await f.qo.open({ matrixId: "@a:x", cents: 500, fundingSource: "venmo" });
  assert.equal((f.orders[0] as { fundingSource?: string }).fundingSource, "venmo");
});

test("a PayPal failure propagates (the pending row is harmless — nothing reads pending)", async () => {
  const f = fakes({ orderFails: true });
  await assert.rejects(() => f.qo.open({ matrixId: "@a:x", cents: 500 }), /paypal create order/);
});

test("orderPurpose: absent/tip = tip, points = points, anything else (the retired 'qorm' too) refused", () => {
  assert.equal(orderPurpose(undefined), "tip");
  assert.equal(orderPurpose("tip"), "tip");
  assert.equal(orderPurpose("points"), "points");
  assert.equal(orderPurpose("qorm"), null);
  assert.equal(orderPurpose("donation"), null);
  assert.equal(orderPurpose(5), null);
});
