-- v149 — payment reversals that arrive out of order (external review S2 + S4).
--
-- Stripe and PayPal do not deliver events in the order they happened. One row per reversal
-- (keyed by the clawback ledger ref the handler already builds — `stripe:refund:<id>`,
-- `stripe:dispute:<id>`, `paypal:refund:<id>`, `paypal:dispute-capture:<capture>`) records what
-- the ledger alone cannot:
--
--   pending    a refund/dispute arrived before the credit it reverses existed. The credit, when
--              it lands, takes it back in the same transaction (then `applied`).
--   applied    a pending reversal that a late credit has taken back.
--   cancelled  terminal: the refund failed or was cancelled, or the dispute was won — so the
--              money stayed. A late opening event for this ref takes nothing.
--
-- A reversal that finds its credit already there writes no row: the clawback ledger row is its
-- record, as before. payment_key/payment_id/cents/reason are null only on a `cancelled` row
-- written before its opening event, which is all a restore event knows.

BEGIN;

CREATE TABLE IF NOT EXISTS site.payment_reversals (
  ref          TEXT        PRIMARY KEY,
  payment_key  TEXT        CHECK (payment_key IN ('payment_intent', 'capture_id')),
  payment_id   TEXT,
  cents        BIGINT      CHECK (cents > 0),
  reason       TEXT        CHECK (reason IN ('refund', 'dispute')),
  status       TEXT        NOT NULL CHECK (status IN ('pending', 'applied', 'cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_reversals_opened_has_payment CHECK (
    status = 'cancelled' OR (payment_key IS NOT NULL AND payment_id IS NOT NULL AND cents IS NOT NULL AND reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS payment_reversals_pending
  ON site.payment_reversals (payment_key, payment_id) WHERE status = 'pending';

INSERT INTO public.schema_migrations (version, note)
VALUES (149, 'site.payment_reversals: refunds/disputes and their outcomes that arrive before the credit')
ON CONFLICT DO NOTHING;

COMMIT;
