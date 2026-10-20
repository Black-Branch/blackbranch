import pool from "@/lib/db";
import { matrixLocalpart } from "./chatIdentity";
import { groupGiftPurchases, iso, type GiftGivenRow, type GiftPendingRow } from "./giftLedger";
import type { GiftPurchaseView, GiftReceivedView } from "./supportStatus";

// The queries behind the gifter's ledger (GET /api/billing/gifts). Read-only —
// giftServer.recordGift (the billing webhook) is the only writer of both
// tables. The grouping itself is pure and lives in giftLedger.ts; the view
// types live with the copy in supportStatus.ts so the client never imports
// this (pool-backed) module.

type GivenRawRow = Omit<GiftGivenRow, "recipient_name"> & { recipient_matrix_id: string; recipient_name: string | null };
type ReceivedRow = { from_id: string | null; from_name: string | null; months: number; expires_at: string | Date };

/** Everything the caller has given and received. */
export async function loadGiftLedger(
  matrixId: string,
  now: Date = new Date()
): Promise<{ given: GiftPurchaseView[]; received: GiftReceivedView[] }> {
  const givenQ = pool
    .query<GivenRawRow>(
      `SELECT g.stripe_session_id, g.kind, g.months, g.anonymous, g.created_at,
              g.recipient_matrix_id, ru.display_name AS recipient_name, g.expires_at
       FROM site.gift_subscriptions g
       LEFT JOIN site.users ru ON ru.matrix_id = g.recipient_matrix_id
       WHERE g.gifter_matrix_id = $1
       ORDER BY g.created_at DESC`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as GivenRawRow[] }));
  const pendingQ = pool
    .query<GiftPendingRow>(
      `SELECT p.stripe_session_id, p.months, p.anonymous, p.created_at, p.claimed_by, p.claimed_at, p.claim_expires_at
       FROM site.gift_pending p
       WHERE p.gifter_matrix_id = $1`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as GiftPendingRow[] }));
  // An anonymous gifter's identity never leaves the server: both the id and
  // the name are nulled in SQL, not filtered afterwards.
  const receivedQ = pool
    .query<ReceivedRow>(
      `SELECT CASE WHEN g.anonymous THEN NULL ELSE g.gifter_matrix_id END AS from_id,
              CASE WHEN g.anonymous THEN NULL ELSE gu.display_name END AS from_name,
              g.months, g.expires_at
       FROM site.gift_subscriptions g
       LEFT JOIN site.users gu ON gu.matrix_id = g.gifter_matrix_id
       WHERE g.recipient_matrix_id = $1
       ORDER BY g.expires_at DESC`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as ReceivedRow[] }));

  const [given, pending, received] = await Promise.all([givenQ, pendingQ, receivedQ]);
  // Name fallback is chatIdentity's ONE rule: display name, else the local part.
  const givenRows: GiftGivenRow[] = given.rows.map((r) => ({
    ...r,
    recipient_name: r.recipient_name || matrixLocalpart(r.recipient_matrix_id),
  }));
  return {
    given: groupGiftPurchases(givenRows, pending.rows, now),
    received: received.rows.map((r) => ({
      from: r.from_id == null ? null : r.from_name || matrixLocalpart(r.from_id),
      months: r.months,
      expiresAt: iso(r.expires_at),
      active: new Date(iso(r.expires_at)) > now,
    })),
  };
}
