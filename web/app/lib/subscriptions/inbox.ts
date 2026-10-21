// The provider-event inbox's housekeeping (subscription sources §3.1, §9, decision D31).
//
// site.subscription_events keeps a body only on inbox rows (Patreon, Ko-fi — S2, S4), and only as
// long as it is needed: a Ko-fi body holds an email, a name and a message; a Patreon body can hold
// a full name. Thirty days after it was received the body goes, WHATEVER the outcome — "cleared
// once applied" alone would keep a failed row's body for ever. The row keeps its ids and outcome,
// marked so it is plainly no longer retryable.

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> };

/** Days an inbox body is kept, whatever its outcome. */
const BODY_DAYS = 30;

/** Clear every inbox body older than BODY_DAYS. Returns how many were cleared. Idempotent.
 *  @parked its caller is the S2 inbox drain's sweep (beside startGiftExpirySweep); no inbox row
 *  exists before S2 writes the first one. */
export async function clearExpiredBodies(db: Queryable): Promise<number> {
  const r = await db.query(
    `UPDATE site.subscription_events
        SET body = NULL,
            outcome = CASE
              WHEN outcome LIKE 'failed:%' THEN outcome || '; body expired'
              WHEN outcome IS NULL THEN 'failed:not applied; body expired'
              ELSE outcome END
      WHERE body IS NOT NULL AND received_at < now() - make_interval(days => $1)`,
    [BODY_DAYS]);
  return r.rowCount ?? 0;
}
