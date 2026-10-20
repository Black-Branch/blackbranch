// Read/write layer for site.payment_events (migrate-v123.sql). Injectable-pool
// factory (coinsServer.ts's createEarn shape) — web/lib/db.ts opens a real
// pg.Pool behind the @/lib/db alias, which plain node --test cannot resolve.
// No bound production singleton here — paymentEventHandlers.ts is the sole
// production binder, over its own pool import (see the third deviation
// above: a same-named local binding there would hide a dead export here).
import type { Pool } from "pg";

/** Trim, then '' -> null. donate/route.ts:120 stamps matrix_id: matrixId ?? ""
 *  for a guest — an empty string, not an omitted field — and
 *  site.payment_events.matrix_id REFERENCES site.users(matrix_id), which no
 *  guest row satisfies. Inserting '' throws and 500s the webhook into a
 *  permanent Stripe retry loop on every guest decline. */
export function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" ? null : t;
}

export type PaymentEventRow = {
  provider?: string; eventId: string; eventType: string; occurredAt: Date;
  sessionId?: string | null; paymentIntentId?: string | null; chargeId?: string | null;
  subscriptionId?: string | null; matrixId?: string | null; kind?: string | null;
  amountCents?: number | null; currency?: string | null; outcome: string;
  reasonCode?: string | null; declineCode?: string | null; reasonText?: string | null;
};

export function createPaymentEventsServer(deps: { pool: Pool }) {
  async function recordPaymentEvent(row: PaymentEventRow): Promise<{ inserted: boolean }> {
    const { rows } = await deps.pool.query(
      `INSERT INTO site.payment_events
         (provider, event_id, event_type, occurred_at, session_id, payment_intent_id, charge_id,
          subscription_id, matrix_id, kind, amount_cents, currency, outcome, reason_code,
          decline_code, reason_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [
        row.provider ?? "stripe", row.eventId, row.eventType, row.occurredAt,
        row.sessionId ?? null, row.paymentIntentId ?? null, row.chargeId ?? null,
        row.subscriptionId ?? null, row.matrixId ?? null, row.kind ?? null,
        row.amountCents ?? null, row.currency ?? null, row.outcome,
        row.reasonCode ?? null, row.declineCode ?? null, row.reasonText ?? null,
      ]
    );
    return { inserted: rows.length > 0 };
  }

  /** Marks the donations row only — the wallet clawback itself lives in
   *  paymentEventHandlers.ts's handleRefund, via MoneyCredits.clawbackForPayment.
   *  refunded_at IS NULL makes a redelivered refund.updated a no-op here. */
  async function markDonationRefunded(paymentIntentId: string): Promise<void> {
    await deps.pool.query(
      `UPDATE site.donations SET refunded_at = NOW()
       WHERE stripe_payment_intent = $1 AND refunded_at IS NULL`,
      [paymentIntentId]
    );
  }

  /** Subscription-mode failures carry no payment_intent_data metadata. */
  async function resolveMatrixIdByCustomer(customerId: string): Promise<string | null> {
    const { rows } = await deps.pool.query<{ matrix_id: string }>(
      `SELECT matrix_id FROM site.subscriptions WHERE stripe_customer_id = $1
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [customerId]
    );
    return rows[0]?.matrix_id ?? null;
  }

  /** A dispute carries no customer field — recover identity via the
   *  payment_intent join site.donations already carries. */
  async function resolveMatrixIdByPaymentIntent(paymentIntentId: string): Promise<string | null> {
    const { rows } = await deps.pool.query<{ matrix_id: string }>(
      `SELECT matrix_id FROM site.donations WHERE stripe_payment_intent = $1`, [paymentIntentId]
    );
    return rows[0]?.matrix_id ?? null;
  }

  return { recordPaymentEvent, markDonationRefunded, resolveMatrixIdByCustomer, resolveMatrixIdByPaymentIntent };
}
