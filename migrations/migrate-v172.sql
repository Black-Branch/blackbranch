-- v172: a gift's start is stored (site.gift_subscriptions.starts_at).
--
-- The start used to be derived from the end: `expires_at - make_interval(months => months)`. Postgres
-- clamps month arithmetic (Oct 31 + 1 month = Nov 30; Nov 30 - 1 month = Oct 30), so the derived
-- start was a day early whenever the real start fell on a day the end's month lacks — a gift queued
-- behind a period ending on the 31st told its recipient it began on the 30th (CI 40250307555,
-- 2026-10-26). From this release every writer sets starts_at — the grant (web giftServer.ts
-- grantGift), the renewal mover (subscriptions/giftQueue.ts realignQueuedGifts) and a restored
-- reversal — and every reader uses it (giftStart.test.ts keeps the derivation from coming back).
--
-- Backfill, the best value the rows hold, in order (E = the end before any reversal clipped it):
--   1. created_at, when created_at + months = E exactly: the grant wrote E as now() + months in the
--      same transaction as created_at, so the gift had nothing ahead of it and began at its grant.
--   2. another gift of the same recipient whose E + months = this E: stacked behind that gift, it
--      began when that one ended.
--   3. else E - months: a gift queued behind paid time (the period end it waited for is not stored
--      anywhere), or one re-dated or restored since. These pre-v172 rows may be a day early at month
--      ends. A gift still following a subscription is re-dated to the paid term's end by the hourly
--      sweep (realignQueuedGifts), which writes the exact start.
-- The comparisons run in the session's time zone, as the writes did; a row they cannot match falls
-- through to 3.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the backfill touches only rows with no start.
BEGIN;

ALTER TABLE site.gift_subscriptions ADD COLUMN IF NOT EXISTS starts_at timestamptz;

UPDATE site.gift_subscriptions g
   SET starts_at = CASE
         WHEN g.created_at + make_interval(months => g.months) = COALESCE(g.expires_before_reversal, g.expires_at) THEN g.created_at
         ELSE COALESCE(
           (SELECT max(COALESCE(p.expires_before_reversal, p.expires_at)) FROM site.gift_subscriptions p
             WHERE p.recipient_matrix_id = g.recipient_matrix_id AND p.id <> g.id
               AND COALESCE(p.expires_before_reversal, p.expires_at) + make_interval(months => g.months)
                   = COALESCE(g.expires_before_reversal, g.expires_at)),
           COALESCE(g.expires_before_reversal, g.expires_at) - make_interval(months => g.months))
       END
 WHERE g.starts_at IS NULL;

ALTER TABLE site.gift_subscriptions ALTER COLUMN starts_at SET NOT NULL;

COMMENT ON COLUMN site.gift_subscriptions.starts_at IS
  'when the gift begins; written by the grant, the renewal mover and a restored reversal, never derived from expires_at (month arithmetic clamps). Rows from before v172 were backfilled and may be a day early at month ends';

INSERT INTO public.schema_migrations (version, note)
VALUES (172, 'gifts: site.gift_subscriptions.starts_at stored, not derived from expires_at')
ON CONFLICT DO NOTHING;

COMMIT;
