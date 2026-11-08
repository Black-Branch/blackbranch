-- v168: one OAuth client per outside account server, and the client a session's tokens belong to.
--
-- Federated sign-in (an account on another Matrix server) registered a NEW public client on every
-- sign-in and overwrote the account's one site.users.oidc_client_id with it. Every session of the
-- account refreshes with that per-user value, so a second device's sign-in made the first device's
-- refresh token go out as the wrong client: the outside server refused it (RFC 6749 §6) and the first
-- device was signed out. Now:
--   site.oauth_clients — the client this site registered at an outside server's registration
--     endpoint, for one redirect URI, registered once and reused by every member of that server;
--   site.user_sessions.oidc_* — the client, token endpoint and revocation endpoint THIS session's
--     tokens were issued for (NULL on own-server sessions and on sessions from before v168, which
--     keep reading the site.users columns).
BEGIN;

CREATE TABLE IF NOT EXISTS site.oauth_clients (
  registration_endpoint text NOT NULL,
  redirect_uri          text NOT NULL,
  client_id             text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registration_endpoint, redirect_uri)
);

COMMENT ON TABLE site.oauth_clients IS
  'The public OAuth client this site registered (RFC 7591) at an outside account server, keyed by the registration endpoint it was registered at and the redirect URI (v168). Reused by every sign-in to that server.';

ALTER TABLE site.user_sessions
  ADD COLUMN IF NOT EXISTS oidc_token_endpoint      text,
  ADD COLUMN IF NOT EXISTS oidc_client_id           text,
  ADD COLUMN IF NOT EXISTS oidc_revocation_endpoint text;

COMMENT ON COLUMN site.user_sessions.oidc_client_id IS
  'The outside server''s client this session''s tokens were issued to (v168); NULL = an own-server session, or one from before v168 (site.users.oidc_* then).';

INSERT INTO public.schema_migrations (version, note)
VALUES (168, 'oauth_clients: one client per outside account server; session-bound client and endpoints')
ON CONFLICT DO NOTHING;

COMMIT;
