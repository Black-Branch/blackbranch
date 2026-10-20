// The mod queue's read (GET /api/mod/automod), kept apart so a test can run it on a real
// Postgres. Actionable rows from every producer — pending and blocked, plus automod's FLAGGED
// platform rows — at most PER_SENDER per person (newest first), then the newest 50 overall: one
// sender flooding the queue cannot push anyone else's held message out of sight. A sender is
// their site account, else their platform id, else the row itself.
/** @test-only the fairness test asserts the flooder is held to exactly this many rows. */
export const AUTOMOD_QUEUE_PER_SENDER = 5;

export const AUTOMOD_QUEUE_SQL = `
  SELECT id, twitch_msg_id, user_login, user_name, text, category, level, held_at,
         source, status, matched_term, matrix_id, user_id, platform, site_msg_id, confidence
    FROM (
      SELECT h.*, row_number() OVER (
               PARTITION BY COALESCE(h.matrix_id, h.platform || ':' || h.user_id, 'row:' || h.id)
               ORDER BY h.held_at DESC) AS sender_rank
        FROM site.automod_held h
       WHERE h.status IN ('pending','blocked') OR (h.status = 'flagged' AND h.source = 'ai')
    ) q
   WHERE q.sender_rank <= ${AUTOMOD_QUEUE_PER_SENDER}
   ORDER BY q.held_at DESC
   LIMIT 50`;
