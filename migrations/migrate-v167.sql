-- v167: a gift to someone already paying monthly starts AFTER their paid term (area-1 round 2,
-- A1-03 / P08; k 2026-10-25).
--
-- A gift granted while its recipient pays for a subscription FOLLOWS it: the transition function
-- (web subscriptions/state.ts → giftQueue.ts realignQueuedGifts) re-dates it every time the paid
-- term moves, so it begins when the paying stops — never overlapping a month they pay for, never
-- pausing their card. It begins only when the records say the paid term ended.
--
-- The back-fill marks the gifts the old rule already parked: not begun yet, and queued behind an
-- entitling paid record (Stripe or PayPal, not a trial — the fragment paidThroughSql reads). The
-- web's hourly gift sweep then re-dates them. Additive; safe to re-run.
--
-- Also site.gift_reversals (+ reversed_by columns): a refund or dispute of a gift ends what its
-- amount covers (unclaimed slots first), and a failed refund or a won dispute restores exactly that.

BEGIN;

ALTER TABLE site.gift_subscriptions
  ADD COLUMN IF NOT EXISTS follows_subscription boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN site.gift_subscriptions.follows_subscription IS
  'true = granted behind a paid subscription: re-dated to begin when the paid term ends (giftQueue.ts)';

UPDATE site.gift_subscriptions g SET follows_subscription = true
 WHERE NOT g.follows_subscription
   AND g.expires_at - make_interval(months => g.months) > now()
   AND EXISTS (
     SELECT 1 FROM site.subscription_records r
      WHERE r.matrix_id = g.recipient_matrix_id AND r.tier IS NOT NULL
        AND r.status IN ('active', 'past_due')
        AND (r.access_until IS NULL OR r.access_until > now())
        AND r.provider IN ('stripe', 'paypal')
        AND r.provider_status <> 'trialing');

-- A refund or dispute of a gift's payment and what it ended, so a failed refund, a won dispute or a
-- harmlessly closed inquiry RESTORES exactly that (area-1 round 2: P10, review R3/R4). Keyed on the
-- reversal's own ref (stripe:refund:<id>, stripe:dispute:<id>) — idempotent per reversal.
CREATE TABLE IF NOT EXISTS site.gift_reversals (
  ref               TEXT PRIMARY KEY,
  stripe_session_id TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (reason IN ('refund', 'dispute')),
  amount_cents      INTEGER,                    -- refunded/disputed, in the payment's minor units; NULL = whole
  purchase_cents    INTEGER,                    -- the purchase's own price (its Checkout session), minor units
  purchase_slots    INTEGER,                    -- the purchase's own slot count (1 for a direct gift)
  slot_cents        INTEGER,                    -- one slot's share of the purchase
  remainder_cents   INTEGER NOT NULL DEFAULT 0, -- the SESSION's refunded money covering no whole slot, on its latest reversal (the Doctor shows it)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gift_reversals_session_idx ON site.gift_reversals (stripe_session_id);

ALTER TABLE site.gift_subscriptions
  ADD COLUMN IF NOT EXISTS reversed_by TEXT,
  ADD COLUMN IF NOT EXISTS expires_before_reversal TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,  -- when THIS gift was ended (a restore gives back exactly that time)
  ADD COLUMN IF NOT EXISTS follows_before_reversal BOOLEAN;
COMMENT ON COLUMN site.gift_subscriptions.reversed_by IS
  'the gift_reversals.ref that ended this gift; NULL = not ended by a refund or dispute';

ALTER TABLE site.gift_pending ADD COLUMN IF NOT EXISTS reversed_by TEXT;
COMMENT ON COLUMN site.gift_pending.reversed_by IS
  'the gift_reversals.ref that withdrew this unclaimed slot; a withdrawn slot cannot be claimed';

INSERT INTO public.schema_migrations (version, note)
VALUES (167, 'gift follows the paid term (follows_subscription) + gift_reversals: refunds and disputes end and restore gifts')
ON CONFLICT DO NOTHING;

COMMIT;
