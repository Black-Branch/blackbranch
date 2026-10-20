// PayPal/Venmo Qorm purchases — the order side (Qorm for all income, Piece 2).
//
// A quiet purchase is parked in site.paypal_coin_orders (migrate-v125.sql),
// never site.donations — every reader of donations counts a row there as a
// tip. PayPal's custom_id carries POINTS_CUSTOM_ID_PREFIX + the row's key so the
// capture webhook (paypalWebhookHandlers.ts) can tell a purchase from a tip;
// tips keep their bare uuid, so live tips are untouched.
//
// Injectable-pool factory (paypalWebhookHandlers.ts's shape): the route
// imports @/auth and @/lib/db, which node --test cannot load, so the part of
// the route that writes and calls PayPal lives here where a fake pool can
// drive it. Like the tip route, this writes ONLY the pending row: the webhook
// is the only writer of anything past this point.
import type { Pool } from "pg";
import { createPaypalOrder as realCreatePaypalOrder, type PaypalFundingSource } from "./paypalClient.ts";
import pool from "../../lib/db.ts";

/** Written by this file's own `open()`; read back through pointsOrderKey below, which
 *  paypalWebhookHandlers.ts's onCaptureCompleted uses to recognize a points purchase's
 *  custom_id and route it away from the tip path. */
const POINTS_CUSTOM_ID_PREFIX = "points:";

/** The site.paypal_coin_orders key inside a points-purchase custom_id, or null when the custom_id is
 *  not one (a tip carries its bare uuid). Only the current prefix: an order opened under an older
 *  prefix fails to match, and is paid by hand. */
export function pointsOrderKey(customId: string): string | null {
  return customId.startsWith(POINTS_CUSTOM_ID_PREFIX) ? customId.slice(POINTS_CUSTOM_ID_PREFIX.length) : null;
}

/** The order body's `purpose`: absent or "tip" = a live tip, "points" = a quiet points purchase,
 *  anything else = null (the route refuses it). */
export function orderPurpose(raw: unknown): "tip" | "points" | null {
  if (raw === undefined || raw === null || raw === "tip") return "tip";
  if (raw === "points") return "points";
  return null;
}

/** @parked consumed by the production binding below and by
 *  paypalPointsOrder.test.ts; exported so the test can drive a fake pool and a
 *  fake PayPal, same shape as createPaypalWebhookHandlers. */
export function createPointsOrders(deps: { pool: Pool; createPaypalOrder: typeof realCreatePaypalOrder }) {
  async function open(a: { matrixId: string; cents: number; fundingSource?: PaypalFundingSource }): Promise<{ orderId: string }> {
    const externalId = crypto.randomUUID();
    await deps.pool.query(
      `INSERT INTO site.paypal_coin_orders (external_id, matrix_id, amount_cents) VALUES ($1, $2, $3)`,
      [externalId, a.matrixId, a.cents],
    );
    return deps.createPaypalOrder({ amountUsd: a.cents / 100, customId: `${POINTS_CUSTOM_ID_PREFIX}${externalId}`, fundingSource: a.fundingSource });
  }
  return { open };
}

/** Production binding — consumed by app/api/billing/paypal/order/route.ts. */
export const pointsOrders = createPointsOrders({ pool, createPaypalOrder: realCreatePaypalOrder });
