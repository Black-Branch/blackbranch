-- v175: the chat socket's real connections per page session (site.device_health.socket_opens).
--
-- socket_reconnects counts every close that schedules a retry, including attempts that never
-- opened, so a browser that cannot reach the socket's host at all climbs about twice a minute and
-- reads exactly like a connection that keeps dropping. socket_opens counts the connections that
-- really opened: reconnects high with opens low = chat could not connect.
-- NULL = the page predates the count (a cached older build), never "zero connections".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
BEGIN;

ALTER TABLE site.device_health ADD COLUMN IF NOT EXISTS socket_opens integer;

COMMENT ON COLUMN site.device_health.socket_opens IS
  'chat socket connections that really opened this page session; NULL = the page did not report it (older build)';

INSERT INTO public.schema_migrations (version, note)
VALUES (175, 'device health: site.device_health.socket_opens, real socket connections apart from retries')
ON CONFLICT DO NOTHING;

COMMIT;
