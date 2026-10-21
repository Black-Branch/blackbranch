import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorePricing } from "./storePricingServer.ts";
import { dampen, renderPrice } from "./storePricing.ts";

/** Fake pool answering by SQL pattern rather than call order, so a test does
 *  not break when an unrelated statement is added — same shape as
 *  coinsServerEarn.test.ts. */
function fakePool(handlers: Array<[RegExp, (p: unknown[]) => { rows: unknown[]; rowCount: number }]>) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { seen, pool: { connect: async () => client, query: client.query } as never };
}

// `pg` returns NUMERIC and BIGINT as strings. Every fixture below says so on
// purpose: a test that hands back JS numbers would pass while production
// concatenated "0.55" onto a string and priced a sticker at NaN.
function priceRow(item_key: string, base_streams: string, price: string) {
  return { item_key, base_streams, price };
}

test("getStorePrices returns every row as a number, from pg's strings", async () => {
  const { pool } = fakePool([
    [/FROM site\.store_prices/, () => ({
      rows: [priceRow("sticker", "0.550", "25"), priceRow("badge_slot", "55.000", "2500")],
      rowCount: 2,
    })],
  ]);
  const prices = await createStorePricing({ pool }).getStorePrices();
  assert.deepEqual(prices, { sticker: 25, badge_slot: 2_500 });
});

test("getPrice returns null for an unknown item rather than a default", async () => {
  // A silent default is a free item, or worse a wrong charge. The caller must
  // be forced to decide what an unpriced key means.
  const { pool } = fakePool([
    [/FROM site\.store_prices/, () => ({ rows: [priceRow("sticker", "0.550", "25")], rowCount: 1 })],
  ]);
  const svc = createStorePricing({ pool });
  assert.equal(await svc.getPrice("sticker"), 25);
  assert.equal(await svc.getPrice("no_such_item"), null);
});

test("getE reads the singleton and returns a number", async () => {
  const { pool } = fakePool([
    [/FROM site\.store_price_state/, () => ({ rows: [{ e_value: "45.000" }], rowCount: 1 })],
  ]);
  assert.equal(await createStorePricing({ pool }).getE(), 45);
});

test("getE throws when the singleton is missing", async () => {
  // Every price derives from E. Returning a fallback would render the whole
  // store at a number nobody chose.
  const { pool } = fakePool([[/FROM site\.store_price_state/, () => ({ rows: [], rowCount: 0 })]]);
  await assert.rejects(() => createStorePricing({ pool }).getE(), /store_price_state/);
});

test("recompute writes dampen(previous, renderPrice(base, e)) per row", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.store_prices[\s\S]*FOR UPDATE/, () => ({
      // 0.55 streams at E=90 renders to 50. At 25 points one ladder step IS the
      // whole move — there is nothing finer than 25 on the ladder.
      rows: [priceRow("sticker", "0.550", "25"), priceRow("tts", "3.300", "150")],
      rowCount: 2,
    })],
  ]);
  const changed = await createStorePricing({ pool }).recomputeStorePrices(90);

  assert.equal(dampen(25, renderPrice(0.55, 90)), 50);
  assert.equal(dampen(150, renderPrice(3.3, 90)), 175);
  assert.deepEqual(changed, [
    { itemKey: "sticker", from: 25, to: 50 },
    { itemKey: "tts", from: 150, to: 175 },
  ]);

  const writes = seen.filter((q) => /UPDATE site\.store_prices/.test(q.sql));
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((w) => w.params), [[50, "sticker"], [175, "tts"]]);
});

test("recompute does not write a row whose price is unchanged", async () => {
  // No pointless updated_at churn: updated_at is how we tell when a price a
  // viewer is looking at last moved.
  const { pool, seen } = fakePool([
    [/FROM site\.store_prices[\s\S]*FOR UPDATE/, () => ({
      rows: [priceRow("sticker", "0.550", "25"), priceRow("tts", "3.300", "150")],
      rowCount: 2,
    })],
  ]);
  const changed = await createStorePricing({ pool }).recomputeStorePrices(45);
  assert.deepEqual(changed, []);
  assert.equal(seen.filter((q) => /UPDATE site\.store_prices/.test(q.sql)).length, 0);
});

test("recompute stamps computed_at even when no price moved", async () => {
  // The question "did the recompute run?" must be answerable separately from
  // "did anything change?" — otherwise a recompute that silently stopped
  // running looks exactly like a stable store.
  const { pool, seen } = fakePool([
    [/FROM site\.store_prices[\s\S]*FOR UPDATE/, () => ({
      rows: [priceRow("sticker", "0.550", "25")],
      rowCount: 1,
    })],
  ]);
  await createStorePricing({ pool }).recomputeStorePrices(45);
  const stamp = seen.find((q) => /UPDATE site\.store_price_state/.test(q.sql));
  assert.ok(stamp, "expected computed_at to be stamped");
  assert.deepEqual(stamp.params, [45]);
});

test("recompute runs in one transaction and locks the rows it rewrites", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.store_prices[\s\S]*FOR UPDATE/, () => ({
      rows: [priceRow("sticker", "0.550", "25")],
      rowCount: 1,
    })],
  ]);
  await createStorePricing({ pool }).recomputeStorePrices(90);
  const sql = seen.map((q) => q.sql.trim());
  assert.equal(sql[0], "BEGIN");
  assert.equal(sql[sql.length - 1], "COMMIT");
  assert.ok(/FOR UPDATE/.test(sql[1] ?? ""), "the read that decides the new prices must lock");
});

test("recompute rolls back and rethrows when a write fails", async () => {
  const { pool, seen } = fakePool([
    [/FROM site\.store_prices[\s\S]*FOR UPDATE/, () => ({
      rows: [priceRow("sticker", "0.550", "25")],
      rowCount: 1,
    })],
    [/UPDATE site\.store_prices/, () => { throw new Error("write failed"); }],
  ]);
  await assert.rejects(() => createStorePricing({ pool }).recomputeStorePrices(90), /write failed/);
  assert.ok(seen.some((q) => q.sql.trim() === "ROLLBACK"), "expected ROLLBACK");
  assert.ok(!seen.some((q) => q.sql.trim() === "COMMIT"), "must not COMMIT after a failed write");
});

test("recompute refuses a non-positive E instead of zeroing the store", async () => {
  const { pool, seen } = fakePool([]);
  await assert.rejects(() => createStorePricing({ pool }).recomputeStorePrices(0), /E/);
  assert.equal(seen.length, 0, "must not open a transaction for an invalid E");
});
