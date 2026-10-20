-- v154 — reconciling an unpriced payment, and reversing a refunded or disputed one.
--
-- stream.unpriced_support (v151) kept a payment the ledger could not price, with no way to settle
-- it. `status` records what a person decided: 'open' until then, 'reconciled' once POST
-- /support/reconcile credited it to the ledger under its stored event_id (with the USD amount
-- they gave, in reconciled_amount_usd), 'dismissed' when it is closed with no credit.
--
-- `reason` tells two kinds of row apart: 'unpriced' (no rate for the currency — a re-post of the
-- event is a duplicate until it is reconciled) and 'ledger_failed' (stream-api could not write the
-- ledger row: a permanent database error, or a transient one past its retries; amount_native is
-- then the take-home in USD and currency 'USD'). A later delivery of a 'ledger_failed' event that
-- does reach the ledger settles its row as 'reconciled' by itself.
--
-- stream.support_events.reverses_id: a refund or dispute of a payment is a NEGATIVE ledger row
-- pointing at the row it reverses (POST /support/reverse; event_type 'reversal', or
-- 'reversal-restore' when a failed refund or a won dispute gives it back). Such rows carry no
-- stream_id, so the per-stream bar never sums them; lifetime support, tiers and sponsor weighting
-- do. Nothing existing is rewritten: every row before this has reverses_id NULL.

BEGIN;

ALTER TABLE stream.unpriced_support
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciled_amount_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'unpriced';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unpriced_support_status_check') THEN
    ALTER TABLE stream.unpriced_support
      ADD CONSTRAINT unpriced_support_status_check CHECK (status IN ('open', 'reconciled', 'dismissed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unpriced_support_reason_check') THEN
    ALTER TABLE stream.unpriced_support
      ADD CONSTRAINT unpriced_support_reason_check CHECK (reason IN ('unpriced', 'ledger_failed'));
  END IF;
END $$;

ALTER TABLE stream.support_events
  ADD COLUMN IF NOT EXISTS reverses_id BIGINT REFERENCES stream.support_events(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_events_reversal_shape') THEN
    ALTER TABLE stream.support_events
      ADD CONSTRAINT support_events_reversal_shape CHECK (
        reverses_id IS NULL OR (event_type IN ('reversal', 'reversal-restore') AND stream_id IS NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS support_events_reverses_id
  ON stream.support_events (reverses_id) WHERE reverses_id IS NOT NULL;

-- stream.erased_restrictions: the PRIVATE moderation record a deleted account leaves when a ban or
-- an open case was holding it (account-erase.js). Its public profile is gone and a platform id's
-- next message starts a fresh identity — which identity.js then marks (site.user_marks) as carrying
-- the restriction, and never binds back to the deleted account. Platform and id only, plus which
-- account and why; read by no public route.
CREATE TABLE IF NOT EXISTS stream.erased_restrictions (
  platform     TEXT        NOT NULL,
  platform_id  TEXT        NOT NULL,
  matrix_id    TEXT        NOT NULL,
  reason       TEXT        NOT NULL CHECK (reason IN ('ban', 'case')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (platform, platform_id)
);

INSERT INTO public.schema_migrations (version, note)
VALUES (154, 'unpriced_support status/reason/reconciled_*; support_events.reverses_id; stream.erased_restrictions')
ON CONFLICT DO NOTHING;

COMMIT;
