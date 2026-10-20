// The store's product seed and the admin price edit, against REAL Postgres.
//
// A mock pool cannot reject illegal SQL or notice a column that is not there, and these two
// write what people are charged — so they run on the replayed schema (CI's throwaway pg18, the
// same database donationsSchema.test.ts uses). Every write happens inside ONE outer transaction
// that is rolled back: the module's own BEGIN / COMMIT / ROLLBACK become savepoints, so the
// shared database ends exactly as it started.
//
// Run locally against a replay:
//   ./migrations/replay-into.sh "postgres://…/throwaway"
//   SQL_PARSE_DATABASE_URL=… node --test app/lib/storePricingSeed.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import type { Pool } from "pg";
import { createStorePricing } from "./storePricingServer.ts";
import { PRODUCT_STORE_PRICES, PRODUCT_E, renderPrice } from "./storePricing.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const skip = DB_URL ? false : "SQL_PARSE_DATABASE_URL is not set (CI sets it; see the header to run locally)";

/** A Pool-shaped wrapper over ONE client inside an outer transaction. */
function savepointPool(c: Client): Pool {
  let n = 0;
  const stack: string[] = [];
  const query = (sql: string, params?: unknown[]) => {
    const t = sql.trim().toUpperCase();
    if (t === "BEGIN") { const s = `sp${++n}`; stack.push(s); return c.query(`SAVEPOINT ${s}`); }
    if (t === "COMMIT") return c.query(`RELEASE SAVEPOINT ${stack.pop()}`);
    if (t === "ROLLBACK") { const s = stack.pop(); return c.query(`ROLLBACK TO SAVEPOINT ${s}`); }
    return c.query(sql, params as unknown[]);
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
}

async function inRolledBack(fn: (pool: Pool, c: Client) => Promise<void>) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await fn(savepointPool(c), c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end();
  }
}

const rowsOf = async (c: Client) =>
  (await c.query<{ item_key: string; base_streams: string; price: string }>(
    "SELECT item_key, base_streams, price FROM site.store_prices ORDER BY item_key")).rows
    .map((r) => ({ itemKey: r.item_key, baseStreams: Number(r.base_streams), price: Number(r.price) }));

// A database built from the fresh-install baseline has an empty store until the app's boot seed runs
// (what an install does as it starts); one built from the migration chain holds the chain's rows.
const fromBaseline = async (c: Client) =>
  Number((await c.query("SELECT count(*) AS n FROM public.schema_migrations WHERE note = 'baseline'")).rows[0].n) > 0;
async function ensureStore(pool: Pool, c: Client) {
  if ((await rowsOf(c)).length === 0 && await fromBaseline(c)) await createStorePricing({ pool }).seedIfEmpty();
}

test("the product seed IS what the migration chain leaves — a baseline install gets the same store", { skip }, async (t) => {
  await inRolledBack(async (_pool, c) => {
    if (await fromBaseline(c)) { t.skip("this database started from the baseline: there is no chain here to compare with"); return; }
    const replay = await rowsOf(c);
    assert.ok(replay.length >= 5, `vacuity: the replay has ${replay.length} store rows`);
    const byKey = (a: { itemKey: string }, b: { itemKey: string }) => a.itemKey.localeCompare(b.itemKey);
    assert.deepEqual(
      replay.map(({ itemKey, baseStreams }) => ({ itemKey, baseStreams })).sort(byKey),
      [...PRODUCT_STORE_PRICES].map((p) => ({ ...p })).sort(byKey));
    const e = Number((await c.query("SELECT e_value FROM site.store_price_state WHERE id = 1")).rows[0]?.e_value);
    assert.equal(e, PRODUCT_E);
    for (const r of replay) assert.equal(r.price, renderPrice(r.baseStreams, e), `${r.itemKey}: stored price is not the rendered one`);
  });
});

test("an install that has its store: the boot seed writes NOTHING", { skip }, async () => {
  await inRolledBack(async (pool, c) => {
    await ensureStore(pool, c);
    const before = await rowsOf(c);
    const writes: string[] = [];
    const spy = { ...pool, query: (sql: string, p?: unknown[]) => { if (/INSERT|UPDATE|DELETE/i.test(sql)) writes.push(sql); return pool.query(sql, p as never); },
      connect: async () => { writes.push("connect"); return pool.connect(); } } as unknown as Pool;
    assert.deepEqual(await createStorePricing({ pool: spy }).seedIfEmpty(), { e: false, items: 0 });
    assert.deepEqual(writes, [], "two SELECTs, no transaction, no write statement");
    assert.deepEqual(await rowsOf(c), before);
  });
});

test("a fresh install (no E, no items) gets the product's store at the product's E", { skip }, async () => {
  await inRolledBack(async (pool, c) => {
    await c.query("DELETE FROM site.store_prices");
    await c.query("DELETE FROM site.store_price_state");
    assert.deepEqual(await createStorePricing({ pool }).seedIfEmpty(), { e: true, items: 5 });
    assert.deepEqual(Object.fromEntries((await rowsOf(c)).map((r) => [r.itemKey, r.price])),
      { badge_slot: 2500, highlight: 50, sticker: 25, sticker_boost: 25, tts: 150 });
    assert.equal(await createStorePricing({ pool }).getE(), 45);
  });
});

test("a deleted item is a decision — the seed never resurrects one into a store that has others", { skip }, async () => {
  await inRolledBack(async (pool, c) => {
    await ensureStore(pool, c);
    await c.query("DELETE FROM site.store_prices WHERE item_key = 'badge_slot'");
    assert.deepEqual(await createStorePricing({ pool }).seedIfEmpty(), { e: false, items: 0 });
    assert.equal((await rowsOf(c)).some((r) => r.itemKey === "badge_slot"), false);
  });
});

test("the admin edit: one item's streams, its price re-rendered at the current E; bounds and unknown items refused", { skip }, async () => {
  await inRolledBack(async (pool, c) => {
    await ensureStore(pool, c);
    const sp = createStorePricing({ pool });
    const before = (await rowsOf(c)).find((r) => r.itemKey === "sticker")!;
    const r = await sp.setBaseStreams("sticker", 1);
    assert.deepEqual(r, { ok: true, from: before.price, to: renderPrice(1, await sp.getE()) });
    const after = (await rowsOf(c)).find((x) => x.itemKey === "sticker")!;
    assert.deepEqual([after.baseStreams, after.price], [1, renderPrice(1, await sp.getE())]);
    assert.equal((await sp.getStorePrices()).sticker, after.price, "the spend routes read the new price");
    assert.deepEqual(await sp.setBaseStreams("nope", 1), { ok: false, status: 404, error: "no such store item" });
    assert.equal((await sp.setBaseStreams("sticker", 0)).ok, false);
    assert.equal((await sp.setBaseStreams("sticker", 1001)).ok, false);
    assert.equal((await sp.setBaseStreams("sticker", Number.NaN)).ok, false);
  });
});
