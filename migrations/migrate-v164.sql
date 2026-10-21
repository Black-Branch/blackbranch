-- v164: a PayPal subscribe remembers the price it was sold at.
--
-- Subscription sources S3, owner verification of 2026-10-21. A subscription payment is credited only
-- when it is not below the price the subscription was sold at (an inline price override can make a
-- subscription on the site's plan bill $0.01). That floor used to be the plan's CURRENT price at
-- PayPal: an owner who raised the price refused credit to every existing subscriber's renewal, and
-- one who deactivated an old plan left every renewal on it unpriceable. The floor is now the price
-- the subscription was created at, written with its intent (web subscriptions/paypal.ts
-- startSubscribe).
--
-- No back-fill: an older intent stores only its plan's id, and a plan's price lives only at PayPal
-- (nothing in this database records it), so a migration has nothing to copy. Those intents keep
-- NULL and take the closed path: the plan's current price is read at PayPal when a payment
-- arrives; a failed read is redelivered, and an inactive or deleted plan leaves the payment
-- uncredited for the owner to check by hand — never credited without a floor.
BEGIN;

ALTER TABLE site.subscription_intents
  ADD COLUMN IF NOT EXISTS price_cents integer CHECK (price_cents IS NULL OR price_cents > 0),
  ADD COLUMN IF NOT EXISTS currency text CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$');

COMMENT ON COLUMN site.subscription_intents.price_cents IS
  'The plan''s monthly price when this subscribe started, in the currency''s minor units: the floor a payment of the subscription must meet to be credited. NULL on intents written before v164.';

INSERT INTO public.schema_migrations (version, note)
VALUES (164, 'subscription sources S3: subscription_intents.price_cents + currency (the sale floor is the price sold at)')
ON CONFLICT DO NOTHING;

COMMIT;
