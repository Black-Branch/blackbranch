-- v148 — a lockdown that lasts "until the stream ends".
--
--   until_stream  the stream (stream.sessions.stream_id) that was live when the lever was thrown;
--                 null = not tied to a stream
--
-- site.lockdown_now reads every lever off once that stream has an end time — the same rule as
-- expires_at: no timer, no writer. A stream that starts later never turns it back on (the id is
-- that one stream's). A row naming a stream that is not in stream.sessions reads off too.

BEGIN;

ALTER TABLE site.lockdown
  ADD COLUMN IF NOT EXISTS until_stream text;

CREATE OR REPLACE VIEW site.lockdown_now AS
SELECT l.id,
       (l.signups_disabled AND NOT x.expired)                          AS signups_disabled,
       (l.crosspost_disabled AND NOT x.expired)                        AS crosspost_disabled,
       CASE WHEN x.expired THEN 0 ELSE l.min_account_age_days END      AS min_account_age_days,
       CASE WHEN x.expired THEN '{}'::text[] ELSE l.ingest_paused END  AS ingest_paused,
       (l.sub_only AND NOT x.expired)                                  AS sub_only,
       l.expires_at,
       x.expired,
       l.link_gate,
       l.reason,
       l.updated_by,
       l.updated_at,
       l.until_stream
  FROM site.lockdown l
  CROSS JOIN LATERAL (
    SELECT ((l.expires_at IS NOT NULL AND l.expires_at <= now())
         OR (l.until_stream IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM stream.sessions s WHERE s.stream_id = l.until_stream AND s.ended_at IS NULL))) AS expired
  ) x;

INSERT INTO public.schema_migrations (version, note)
VALUES (148, 'lockdown: until_stream — every lever off once that stream has ended (site.lockdown_now)')
ON CONFLICT DO NOTHING;

COMMIT;
