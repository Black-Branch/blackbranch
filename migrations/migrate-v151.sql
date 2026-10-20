-- v151 — paid events the support ledger could not price.
--
-- A YouTube Super Chat (or a Ko-fi / Streamlabs / Patreon payment) in a currency stream-api has no
-- rate for converts to $0 (economics.toUSD). Until now that wrote NOTHING: stream.support_events is
-- only written for a take-home above zero, so the payment was celebrated on stream and then lost —
-- no row, no audit trail, nothing to reconcile from.
--
-- This table keeps such an event as it arrived: the native amount, the currency as the producer
-- named it, and the raw display string. It is deliberately a separate table, not a status column on
-- stream.support_events: every reader of the ledger (the support bar, the timer, the sponsor pool,
-- the meter, the aggregates) sums that table, and each would have to learn to skip a new status.
-- Nothing reads this table for any total.
--
-- `event_id` is the same namespaced key the ledger uses (`alert:<platform>:<id>`). Its unique index
-- is also the replay answer for an unpriced event: a second delivery of the same id inserts nothing,
-- and stream-api fires no effects for it again. Reconciling a row later goes through the existing
-- idempotent credit path keyed on that event_id (a support_events row with the same key), never an
-- edit of a financial row in place.

BEGIN;

CREATE TABLE IF NOT EXISTS stream.unpriced_support (
  id            BIGSERIAL   PRIMARY KEY,
  event_id      TEXT,
  platform      TEXT        NOT NULL,
  event_type    TEXT,
  user_id       TEXT,
  username      TEXT        NOT NULL,
  amount_native NUMERIC     NOT NULL,
  currency      TEXT        NOT NULL,
  raw           TEXT,
  message       TEXT,
  stream_id     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS unpriced_support_event_id
  ON stream.unpriced_support (event_id) WHERE event_id IS NOT NULL;

INSERT INTO public.schema_migrations (version, note)
VALUES (151, 'stream.unpriced_support: paid events whose currency the ledger cannot price, kept for reconciliation')
ON CONFLICT DO NOTHING;

COMMIT;
