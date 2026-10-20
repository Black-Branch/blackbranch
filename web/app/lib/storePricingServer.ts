// Store prices — the server side of the streams-to-Qorm rendering.
//
// site.store_prices holds base_streams (the source of truth) and `price` (the
// rendered Qorm figure). Reads take the cached `price`, never recompute it: the
// number a viewer was shown has to be a stored fact, because the spend routes
// compare against it and refuse with `price_changed` on a mismatch. A price
// recomputed per request would make that comparison meaningless.
//
// The factory-over-a-pool shape is currentStream.ts's, for the same reason —
// it lets the tests drive a fake pool rather than a live database.
//
// `pg` returns NUMERIC and BIGINT as strings; every one is mapped through
// Number(). Relative imports carry `.ts` because node --test loads this module
// directly and does not understand the tsconfig "@/*" alias.
import type { Pool } from "pg";
import pool from "../../lib/db.ts";
import {
  planRecompute, renderPrice, PRODUCT_STORE_PRICES, PRODUCT_E, BASE_STREAMS_MIN, BASE_STREAMS_MAX,
  type PriceChange,
} from "./storePricing.ts";

export type { PriceChange };

type RawPriceRow = { item_key: string; base_streams: string; price: string };

/** `pg` hands back NUMERIC and BIGINT as strings; the pure layer works in
 *  numbers. One conversion point, so a missed Number() cannot reach the
 *  arithmetic. */
function toPriceRow(r: RawPriceRow) {
  return { itemKey: r.item_key, baseStreams: Number(r.base_streams), price: Number(r.price) };
}

/** @parked consumed by the production singleton below and by
 *  storePricingServer.test.ts; exported so the tests can supply a fake pool,
 *  exactly as createCurrentStream is. */
export function createStorePricing(deps: { pool: Pool }) {
  /** The whole table in one query — it is a dozen rows, and every consumer
   *  wants more than one of them. */
  async function getStorePrices(): Promise<Record<string, number>> {
    const { rows } = await deps.pool.query<RawPriceRow>(
      `SELECT item_key, base_streams, price FROM site.store_prices ORDER BY item_key`
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.item_key] = Number(r.price);
    return out;
  }

  /** null, never a default. An unpriced key is a bug the caller has to handle:
   *  a default would either give the item away or charge a number nobody set. */
  async function getPrice(itemKey: string): Promise<number | null> {
    const prices = await getStorePrices();
    return prices[itemKey] ?? null;
  }

  async function getE(): Promise<number> {
    const { rows } = await deps.pool.query<{ e_value: string }>(
      `SELECT e_value FROM site.store_price_state WHERE id = 1`
    );
    // Throw rather than fall back: every price derives from E, so a default
    // here would render the entire store at a number nobody chose.
    if (!rows[0]) throw new Error("site.store_price_state row 1 is missing");
    return Number(rows[0].e_value);
  }

  /** What `recomputeStorePrices(e)` WOULD do — same plan, no writes, no lock.
   *  Runs through the same pure planRecompute, so a dry run cannot disagree
   *  with the write it previews.
   *  @parked consumed by scripts/set-e.ts; the only caller until the recompute
   *  has a schedule. */
  async function previewRecompute(e: number): Promise<PriceChange[]> {
    const { rows } = await deps.pool.query<RawPriceRow>(
      `SELECT item_key, base_streams, price FROM site.store_prices ORDER BY item_key`
    );
    return planRecompute(rows.map(toPriceRow), e);
  }

  /** Re-render every price at a new E, damped against the price each item
   *  currently shows. Returns only the rows that actually moved.
   *
   *  @parked NOT SCHEDULED — E is a measurement, and wiring this to a cron
   *  before it is measured would float prices on an unmeasured number. It is
   *  reachable by hand through scripts/set-e.ts, which is deliberately the ONLY
   *  caller: setting e_value in SQL alone moves no price, because `price` is a
   *  stored column and this is what rewrites it. */
  async function recomputeStorePrices(e: number): Promise<PriceChange[]> {
    // Checked before the transaction opens: a non-positive E renders every
    // price to the rounding floor, which is a store-wide giveaway, not an edge
    // case worth handling gracefully.
    if (!(e > 0)) throw new Error(`recomputeStorePrices: E must be positive, got ${e}`);

    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE because the new price is a function of the current one:
      // two concurrent recomputes reading the same previous price would each
      // apply their own ±10% step from it, and the second write would silently
      // discard the first's damping.
      const { rows } = await client.query<RawPriceRow>(
        `SELECT item_key, base_streams, price FROM site.store_prices ORDER BY item_key FOR UPDATE`
      );

      const changed = planRecompute(rows.map(toPriceRow), e);
      for (const c of changed) {
        await client.query(
          `UPDATE site.store_prices SET price = $1, updated_at = now() WHERE item_key = $2`,
          [c.to, c.itemKey]
        );
      }

      // Stamped whether or not anything moved: "did the recompute run?" has to
      // be answerable separately from "did anything change?", or a recompute
      // that quietly stopped running looks exactly like a stable store.
      await client.query(
        `UPDATE site.store_price_state SET e_value = $1, computed_at = now() WHERE id = 1`,
        [e]
      );

      await client.query("COMMIT");
      return changed;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Every item with its stored streams and its price — the admin Points screen's table. */
  async function getPriceRows(): Promise<{ itemKey: string; baseStreams: number; price: number }[]> {
    const { rows } = await deps.pool.query<RawPriceRow>(
      `SELECT item_key, base_streams, price FROM site.store_prices ORDER BY item_key`
    );
    return rows.map(toPriceRow);
  }

  /** Admin: one item's size in streams, its price re-rendered at the CURRENT E in the same
   *  statement (no damping — an explicit choice is not a drift). Only an item that exists: the
   *  items are the product's spend sinks, not something an edit invents. Anyone holding the old
   *  price gets the 409 price_changed guard on their next spend, as with a recompute. */
  async function setBaseStreams(itemKey: string, baseStreams: number): Promise<
    { ok: true; from: number; to: number } | { ok: false; status: 400 | 404; error: string }
  > {
    if (!(Number.isFinite(baseStreams) && baseStreams >= BASE_STREAMS_MIN && baseStreams <= BASE_STREAMS_MAX)) {
      return { ok: false, status: 400, error: `streams must be ${BASE_STREAMS_MIN}–${BASE_STREAMS_MAX}` };
    }
    const rounded = Math.round(baseStreams * 1000) / 1000; // the column is NUMERIC(8,3)
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<RawPriceRow>(
        `SELECT item_key, base_streams, price FROM site.store_prices WHERE item_key = $1 FOR UPDATE`, [itemKey]
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, status: 404, error: "no such store item" }; }
      const e = await client.query<{ e_value: string }>(`SELECT e_value FROM site.store_price_state WHERE id = 1`);
      if (!e.rows[0]) throw new Error("site.store_price_state row 1 is missing");
      const to = renderPrice(rounded, Number(e.rows[0].e_value));
      await client.query(
        `UPDATE site.store_prices SET base_streams = $2, price = $3, updated_at = now() WHERE item_key = $1`,
        [itemKey, rounded, to]
      );
      await client.query("COMMIT");
      return { ok: true, from: Number(rows[0].price), to };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Boot (instrumentation.ts): fill what a fresh install is missing — the E row when absent,
   *  the product's items ONLY when the table is empty. On an install that has both it only
   *  READS (no write statement runs at all). Returns what it wrote, for the boot log. */
  async function seedIfEmpty(): Promise<{ e: boolean; items: number }> {
    const [state, count] = await Promise.all([
      deps.pool.query<{ e_value: string }>(`SELECT e_value FROM site.store_price_state WHERE id = 1`),
      deps.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM site.store_prices`),
    ]);
    if (state.rows[0] && Number(count.rows[0]?.n ?? 0) > 0) return { e: false, items: 0 };
    const client = await deps.pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO site.store_price_state (id, e_value) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [PRODUCT_E]
      );
      const { rows } = await client.query<{ e_value: string }>(`SELECT e_value FROM site.store_price_state WHERE id = 1`);
      const e = Number(rows[0]?.e_value ?? PRODUCT_E);
      let items = 0;
      const { rows: n } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM site.store_prices`);
      if (Number(n[0]?.n ?? 0) === 0) {
        for (const p of PRODUCT_STORE_PRICES) {
          await client.query(
            `INSERT INTO site.store_prices (item_key, base_streams, price) VALUES ($1, $2, $3) ON CONFLICT (item_key) DO NOTHING`,
            [p.itemKey, p.baseStreams, renderPrice(p.baseStreams, e)]
          );
          items++;
        }
      }
      await client.query("COMMIT");
      return { e: (ins.rowCount ?? 0) > 0, items };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { getStorePrices, getPrice, getE, previewRecompute, recomputeStorePrices, getPriceRows, setBaseStreams, seedIfEmpty };
}

/** Production singleton, the same pattern as `currentStream` in currentStream.ts.
 *  Consumed by app/api/store/prices/route.ts and every table-priced spend route. */
export const storePricing = createStorePricing({ pool });
