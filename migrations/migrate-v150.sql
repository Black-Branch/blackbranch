-- v150 — every Stripe customer a viewer has ever had.
--
-- site.subscriptions holds ONE customer per viewer, but a viewer can hold several: a lookup
-- failure used to mint a second customer and overwrite the stored one, and those duplicates can
-- still carry live subscriptions. The billing webhook decides a viewer's row from the
-- subscriptions of ALL their customers, so it needs every customer id, not only the latest one.
--
-- Written by ensureStripeCustomer on every create (same transaction as the mapping) and by the
-- webhook whenever it resolves a viewer for a customer not recorded yet. A customer Stripe no
-- longer holds is deleted by the webhook. Back-filled from the one customer each row stores.

BEGIN;

CREATE TABLE IF NOT EXISTS site.stripe_customers (
  stripe_customer_id TEXT        PRIMARY KEY,
  matrix_id          TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stripe_customers_viewer ON site.stripe_customers (matrix_id);

INSERT INTO site.stripe_customers (stripe_customer_id, matrix_id)
SELECT stripe_customer_id, matrix_id FROM site.subscriptions WHERE stripe_customer_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.schema_migrations (version, note)
VALUES (150, 'site.stripe_customers: every Stripe customer a viewer has had, so the webhook reconciles across all of them')
ON CONFLICT DO NOTHING;

COMMIT;
