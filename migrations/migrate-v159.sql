-- v159: the amount of a credit the support bar and the timer admitted.
--
-- Review round 6, D-D (decided 2026-10-18): a credit whose refunds were HELD before it landed
-- (stream.support_reversal_holds, v156) moves the bar and the timer by its NET only — fully
-- refunded → nothing, partly refunded → the kept part. A refund that arrives after the credit
-- granted its time still takes nothing back.
--
-- The bar is rebuilt on restart by summing the stream's credit rows (a reversal row carries no
-- stream_id), so a live-only fix would put the refunded money back on the bar at the next
-- restart. stream-api money.js writes the admitted amount here, in the same transaction that
-- applies the held reversals; supportbar.js sums COALESCE(admitted_usd, amount_usd).
-- NULL = the row's own amount (every credit with nothing held, and every row before v159).

BEGIN;

ALTER TABLE stream.support_events ADD COLUMN IF NOT EXISTS admitted_usd NUMERIC(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_events_admitted_usd_range') THEN
    ALTER TABLE stream.support_events ADD CONSTRAINT support_events_admitted_usd_range
      CHECK (admitted_usd IS NULL OR (admitted_usd >= 0 AND admitted_usd <= amount_usd));
  END IF;
END $$;

COMMENT ON COLUMN stream.support_events.admitted_usd IS
  'Amount of this credit the per-stream support bar and the timer admitted: its net after refunds held before it landed (review round 6 D-D). NULL = the whole amount_usd.';

INSERT INTO public.schema_migrations (version, note)
VALUES (159, 'stream.support_events.admitted_usd — what the bar/timer admitted of a credit with held refunds')
ON CONFLICT DO NOTHING;

COMMIT;
