-- v160: a linked platform account whose refresh was refused.
--
-- A platform refuses a refresh token for good (Kick and Twitch answer 400/401 once the person
-- revoked the app or the grant aged out). The website used to log that and return nothing, on
-- every send, forever — and the person was never told. web's platformTokens.ts now stamps the
-- refusal here, stops asking the platform, and the account panel offers "Reconnect"; linking
-- again (platformAccountLink.ts) and a later successful refresh clear it.
-- NULL = the link works (every row before v160).

BEGIN;

ALTER TABLE site.accounts ADD COLUMN IF NOT EXISTS refresh_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN site.accounts.refresh_failed_at IS
  'When the platform refused this link''s refresh token (HTTP 400/401). NULL = the link works. Cleared by linking again or by a successful refresh.';

INSERT INTO public.schema_migrations (version, note)
VALUES (160, 'site.accounts.refresh_failed_at — a platform link whose refresh was refused')
ON CONFLICT DO NOTHING;

COMMIT;
