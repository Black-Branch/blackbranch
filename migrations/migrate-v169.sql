-- v169: empty the June-era Matrix token columns on site.users.
--
-- site.users.mx_access_token / mx_refresh_token / mx_token_expires / mx_device_id were superseded by
-- the per-session site.user_sessions rows (v24, 2026-06). No product path reads them, yet rows still
-- hold encrypted refresh tokens an account server may honour: credentials at rest for nothing. This
-- empties them; the columns are dropped in a later migration (migrations/README.md says which).
-- Idempotent: a second run matches no row.
BEGIN;

UPDATE site.users
   SET mx_access_token = NULL, mx_refresh_token = NULL, mx_token_expires = NULL, mx_device_id = NULL
 WHERE mx_access_token IS NOT NULL OR mx_refresh_token IS NOT NULL
    OR mx_token_expires IS NOT NULL OR mx_device_id IS NOT NULL;

COMMENT ON COLUMN site.users.mx_access_token  IS 'Superseded by site.user_sessions (v24); emptied by v169; to be dropped.';
COMMENT ON COLUMN site.users.mx_refresh_token IS 'Superseded by site.user_sessions (v24); emptied by v169; to be dropped.';
COMMENT ON COLUMN site.users.mx_token_expires IS 'Superseded by site.user_sessions (v24); emptied by v169; to be dropped.';
COMMENT ON COLUMN site.users.mx_device_id     IS 'Superseded by site.user_sessions (v24); emptied by v169; to be dropped.';

INSERT INTO public.schema_migrations (version, note)
VALUES (169, 'site.users legacy Matrix token columns emptied (superseded by user_sessions)')
ON CONFLICT DO NOTHING;

COMMIT;
