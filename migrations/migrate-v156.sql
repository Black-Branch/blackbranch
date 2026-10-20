-- v156 — a refund that arrives before the credit it reverses; restrictions that end.
--
-- stream.support_reversal_holds (review round 5, PB2): a refund or dispute of a native payment the
-- support ledger does not hold yet — its ledger write failed and it waits in stream.unpriced_support
-- for POST /support/reconcile, or its credit is still on its way — used to be answered "nothing to
-- reverse" and forgotten, so the later credit counted a refunded payment in full (lifetime support,
-- tier, sponsor weight). It is now held here, keyed by the original's ledger event_id and the
-- reversal's own ref, and the credit takes it back in the SAME transaction when it lands (then
-- `applied`). A restore (refund failed, dispute won) that arrives first leaves a `cancelled` row, so
-- the opening event that follows takes nothing. Both writers serialise on one advisory lock per
-- event_id (money.js). `share` is refunded / gross (NULL = the whole remainder).
--
-- stream.erased_restrictions.expires_at (round 5): a deleted account under a TIMEOUT left a
-- permanent restriction row, so its platform ids could never be linked or merged again. A timeout's
-- row now ends when the timeout does; a permanent ban and an open moderation case stay NULL
-- (never ends). Every reader matches only unexpired rows.

BEGIN;

CREATE TABLE IF NOT EXISTS stream.support_reversal_holds (
  event_id    TEXT        NOT NULL,
  ref         TEXT        NOT NULL,
  reason      TEXT        CHECK (reason IN ('refund', 'dispute')),
  share       NUMERIC     CHECK (share > 0 AND share <= 1),
  status      TEXT        NOT NULL CHECK (status IN ('pending', 'applied', 'cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, ref),
  CONSTRAINT support_reversal_holds_opened_has_reason CHECK (status = 'cancelled' OR reason IS NOT NULL)
);

ALTER TABLE stream.erased_restrictions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

INSERT INTO public.schema_migrations (version, note)
VALUES (156, 'stream.support_reversal_holds (refunds before their credit); erased_restrictions.expires_at')
ON CONFLICT DO NOTHING;

COMMIT;
