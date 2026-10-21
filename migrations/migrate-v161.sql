-- v161: subscription sources, slice S1 — one record per subscription, per service (the expand step).
--
-- Spec: docs/superpowers/specs/2026-10-17-subscription-sources-design.md §3. Until now a viewer had
-- ONE subscription row (site.subscriptions, keyed by the viewer), which could only ever describe one
-- Stripe subscription. These tables hold one row per subscription, tagged with its service, so a
-- later slice can count a Patreon membership (S2), a PayPal subscription (S3) or a Ko-fi membership
-- (S4) beside a card one. S1 moves Stripe onto them and changes nothing a viewer sees.
--
-- EXPAND, then contract (§3.5): site.subscriptions stays, and the one writer of subscription state
-- (web/app/lib/subscriptions/state.ts, called from the Stripe reconciler) keeps writing it in the
-- same transaction as the records, so a web rollback still reads correct state. S1b drops it.
--
-- Every new matrix_id column is declared in web/app/lib/accountDeletion.ts's DELETION_DECLARATION in
-- the same commit; its completeness test reads the generated baseline.
--
-- The back-fill writes one 'stripe' record per site.subscriptions row that names a Stripe
-- subscription. On a fresh install the table is empty, so the baseline carries the tables and no rows.

BEGIN;

-- One subscription, on one service. matrix_id NULL = unclaimed: a payment the site cannot tie to a
-- viewer yet; it never entitles anyone (the entitlement fragment requires matrix_id IS NOT NULL).
CREATE TABLE IF NOT EXISTS site.subscription_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'patreon', 'kofi', 'twitch', 'kick')),
  external_id     text NOT NULL,
  matrix_id       text REFERENCES site.users(matrix_id) ON DELETE CASCADE,
  account_ref     text,
  tier            text,
  status          text NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'paused', 'ended')),
  provider_status text NOT NULL,
  renews          boolean NOT NULL DEFAULT true,
  period_end      timestamptz,
  access_until    timestamptz,
  source_event_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_records_provider_external_key UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS subscription_records_matrix_idx
  ON site.subscription_records (matrix_id) WHERE matrix_id IS NOT NULL;
-- The re-check jobs (S2/S3) read the records whose access is about to run out.
CREATE INDEX IF NOT EXISTS subscription_records_access_idx
  ON site.subscription_records (provider, access_until) WHERE status IN ('active', 'past_due');

COMMENT ON TABLE site.subscription_records IS
  'One row per subscription per service (subscription sources, v161). Written only by web subscriptions/state.ts (writeTransition); a viewer is a Supporter while any entitling row is theirs.';
COMMENT ON COLUMN site.subscription_records.status IS
  'Normalised: pending | active | past_due | paused | ended. active and past_due entitle. provider_status keeps the service''s own word.';
COMMENT ON COLUMN site.subscription_records.access_until IS
  'NULL = status alone decides (Stripe). Else access stops at this time, with no job and no write.';
COMMENT ON COLUMN site.subscription_records.source_event_at IS
  'The ordering stamp of the last write; an observation strictly older than it is dropped as stale.';

-- One row per verified provider event: an audit log for every service, and (S2, S4) the inbox the
-- web drain applies. body is kept only on inbox rows, and never past 30 days whatever the outcome.
CREATE TABLE IF NOT EXISTS site.subscription_events (
  provider    text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'patreon', 'kofi', 'twitch', 'kick')),
  event_id    text NOT NULL,
  event_type  text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  occurred_at timestamptz,
  external_id text,
  body        jsonb,
  applied_at  timestamptz,
  outcome     text CHECK (outcome IS NULL OR outcome IN ('applied', 'stale', 'unclaimed', 'ignored') OR outcome LIKE 'failed:%'),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS subscription_events_inbox_idx
  ON site.subscription_events (received_at) WHERE applied_at IS NULL;
CREATE INDEX IF NOT EXISTS subscription_events_body_idx
  ON site.subscription_events (received_at) WHERE body IS NOT NULL;
CREATE INDEX IF NOT EXISTS subscription_events_record_idx
  ON site.subscription_events (provider, external_id) WHERE external_id IS NOT NULL;

-- One row per recurring payment the site learns of, where the service sends one (PayPal sales, Ko-fi
-- payments). Stripe invoices stay in Stripe.
CREATE TABLE IF NOT EXISTS site.subscription_payments (
  provider     text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'patreon', 'kofi', 'twitch', 'kick')),
  payment_id   text NOT NULL,
  record_id    bigint NOT NULL REFERENCES site.subscription_records(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL,
  currency     text NOT NULL,
  net_cents    integer,
  paid_at      timestamptz NOT NULL,
  spend_id     text,
  credit       text CHECK (credit IS NULL OR credit IN ('pending', 'landed', 'refused')),
  refunded_at  timestamptz,
  reversed_at  timestamptz,
  PRIMARY KEY (provider, payment_id)
);

CREATE INDEX IF NOT EXISTS subscription_payments_record_idx ON site.subscription_payments (record_id);

-- A viewer's linked membership accounts (Patreon, Ko-fi). Never a sign-in identity: site.accounts
-- feeds the canonical chat identity, and a membership link must never become one.
CREATE TABLE IF NOT EXISTS site.subscription_accounts (
  provider         text NOT NULL CHECK (provider IN ('stripe', 'paypal', 'patreon', 'kofi', 'twitch', 'kick')),
  provider_user_id text NOT NULL,
  matrix_id        text NOT NULL REFERENCES site.users(matrix_id) ON DELETE CASCADE,
  linked_at        timestamptz NOT NULL DEFAULT now(),
  linked_via       text NOT NULL CHECK (linked_via IN ('oauth', 'code', 'owner-approved')),
  PRIMARY KEY (provider, provider_user_id),
  CONSTRAINT subscription_accounts_one_per_service UNIQUE (provider, matrix_id)
);

-- The server's half of a PayPal subscribe (S3): the id is the custom_id PayPal carries back.
CREATE TABLE IF NOT EXISTS site.subscription_intents (
  id          text PRIMARY KEY CHECK (id ~ '^si_[0-9A-Za-z]{22}$'),
  matrix_id   text NOT NULL REFERENCES site.users(matrix_id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('stripe', 'paypal')),
  tier        text NOT NULL,
  plan_id     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  external_id text
);

CREATE INDEX IF NOT EXISTS subscription_intents_matrix_idx ON site.subscription_intents (matrix_id);

-- Ko-fi link requests (S4): a one-time code, or an email the owner approves. typed_email is the only
-- clear copy of an address, and goes with the claim.
CREATE TABLE IF NOT EXISTS site.subscription_claims (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  matrix_id   text NOT NULL REFERENCES site.users(matrix_id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('code', 'email')),
  code_hash   text,
  email_hmac  text,
  typed_email text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'approved', 'refused', 'expired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT subscription_claims_shape CHECK (
    (kind = 'code' AND code_hash IS NOT NULL AND email_hmac IS NULL AND typed_email IS NULL)
    OR (kind = 'email' AND code_hash IS NULL AND email_hmac IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS subscription_claims_matrix_idx ON site.subscription_claims (matrix_id);

-- The back-fill: one 'stripe' record per viewer row that names a Stripe subscription. The status
-- mapping is the spec's §3.3 for Stripe, and web/app/lib/subscriptions/stripeRecords.ts's
-- normaliseStripeStatus — subscriptions/backfill.test.ts holds the two equal for every status.
-- A row with no stripe_sub_id is a customer pointer only (stripeCustomer.ts) and gets no record.
-- ON CONFLICT: a re-run (or a record the reconciler already wrote) is left as it is.
INSERT INTO site.subscription_records
  (provider, external_id, matrix_id, account_ref, tier, status, provider_status, renews,
   period_end, access_until, source_event_at, created_at, updated_at)
SELECT 'stripe', s.stripe_sub_id, s.matrix_id, s.stripe_customer_id, s.tier,
       CASE s.status
         WHEN 'active'             THEN 'active'
         WHEN 'trialing'           THEN 'active'
         WHEN 'past_due'           THEN 'past_due'
         WHEN 'incomplete'         THEN 'pending'
         WHEN 'unpaid'             THEN 'paused'
         WHEN 'paused'             THEN 'paused'
         ELSE 'ended'
       END,
       COALESCE(s.status, 'unknown'), NOT s.cancel_at_period_end, s.current_period_end, NULL,
       COALESCE(s.stripe_event_at, s.updated_at), s.updated_at, s.updated_at
  FROM site.subscriptions s
 WHERE s.stripe_sub_id IS NOT NULL
ON CONFLICT (provider, external_id) DO NOTHING;

INSERT INTO public.schema_migrations (version, note)
VALUES (161, 'subscription sources S1: site.subscription_records/events/payments/accounts/intents/claims + Stripe back-fill')
ON CONFLICT DO NOTHING;

COMMIT;
