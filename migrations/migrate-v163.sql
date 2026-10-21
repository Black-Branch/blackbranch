-- v163: a Stripe subscription record's access ends at its period end plus the grace days.
--
-- Subscription sources (spec §3.4), security review of 2026-10-21, finding 4: Stripe records were
-- written with access_until NULL ("status alone decides"), so a customer.subscription.deleted lost
-- for good — the webhook down, or the Stripe module off, past Stripe's ~3 days of retries — left
-- that record entitling for ever. web's Stripe adapter (subscriptions/stripeRecords.ts) now writes
-- access_until = period_end + 7 days on every observation, and each renewal moves it on. This
-- brings the records written before that change to the same rule; one with no period end is left
-- as it is. 7 is the grace the code uses (subscriptions/grace.ts GRACE_DAYS).
--
-- Data only. On a fresh install the table is empty and this changes nothing.
BEGIN;

UPDATE site.subscription_records
   SET access_until = period_end + interval '7 days', updated_at = now()
 WHERE provider = 'stripe' AND access_until IS NULL AND period_end IS NOT NULL;

INSERT INTO public.schema_migrations (version, note)
VALUES (163, 'subscription sources: Stripe records end at period_end + 7 grace days (security review finding 4)')
ON CONFLICT DO NOTHING;

COMMIT;
