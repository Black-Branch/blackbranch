// web/app/lib/paymentResultServer.ts
// The read side of site.payment_events for the buyer-facing result screen.
import type { Pool } from "pg";
import pool from "../../lib/db.ts";
import { declineCopy } from "./declineCopy.ts";

/** @parked consumed by the production binding below and by
 *  paymentResultServer.test.ts; exported so the test can drive a fake pool,
 *  the same shape as coinsServer.ts's createEarn. */
export function createPaymentResultServer(deps: { pool: Pool }) {
  async function latestFailedResult(
    sessionId: string, since: Date
  ): Promise<{ title: string; body: string; canRetry: boolean; at: string } | null> {
    const { rows } = await deps.pool.query<{
      reason_code: string | null; decline_code: string | null; reason_text: string | null; occurred_at: Date;
    }>(
      `SELECT reason_code, decline_code, reason_text, occurred_at
       FROM site.payment_events
       WHERE session_id = $1 AND outcome = 'failed' AND occurred_at > $2
       ORDER BY occurred_at DESC LIMIT 1`,
      [sessionId, since]
    );
    const row = rows[0];
    if (!row) return null;
    const { title, canRetry } = declineCopy(row.reason_code, row.decline_code);
    return { title, body: row.reason_text ?? title, canRetry, at: new Date(row.occurred_at).toISOString() };
  }
  return { latestFailedResult };
}

export const latestFailedResult = createPaymentResultServer({ pool }).latestFailedResult;
