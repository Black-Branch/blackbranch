-- v147 — the lockdown: two more levers and an expiry.
--
--   ingest_paused  the platforms whose chat is not taken in while it holds (stream-api POST /chat
--                  drops their messages before anything else; the site's own chat is never one)
--   sub_only       only subscribers (and mods / admins) may send site chat
--   expires_at     when every lever lifts by itself; null = no expiry
--
-- site.lockdown_now is the singleton as it holds RIGHT NOW: once expires_at has passed, every
-- lockdown lever reads off. Every reader of a lever reads the view, so an expiry needs no timer and
-- no writer. The link gate (link_gate) is a posture, not a lockdown lever, and passes through.
-- The seed row (migrations/baseline/seed.sql) is unchanged: the new columns are column defaults.

BEGIN;

ALTER TABLE site.lockdown
  ADD COLUMN IF NOT EXISTS ingest_paused text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sub_only boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

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
       l.updated_at
  FROM site.lockdown l
  CROSS JOIN LATERAL (SELECT (l.expires_at IS NOT NULL AND l.expires_at <= now()) AS expired) x;

INSERT INTO public.schema_migrations (version, note)
VALUES (147, 'lockdown: ingest_paused + sub_only levers, expires_at, and the site.lockdown_now view (every lever off once expired)')
ON CONFLICT DO NOTHING;

COMMIT;
