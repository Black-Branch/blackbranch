-- v155 — a report can name a platform-only chatter, and the message it is about.
--
-- site.reports.reported_id is a site account (FK → site.users), so a chatter who only ever spoke
-- from a platform could not be reported. A report filed from a message now records that message
-- (message_platform + message_id); the server resolves its author: a site account goes in
-- reported_id as before, a platform-only chatter by canonical id in reported_canonical_id. One of
-- the two is always set. The mod who resolves a report is recorded, as for tickets.

BEGIN;

ALTER TABLE site.reports ALTER COLUMN reported_id DROP NOT NULL;
ALTER TABLE site.reports
  ADD COLUMN IF NOT EXISTS reported_canonical_id TEXT,
  ADD COLUMN IF NOT EXISTS message_platform TEXT,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_target_check') THEN
    ALTER TABLE site.reports ADD CONSTRAINT reports_target_check
      CHECK (reported_id IS NOT NULL OR reported_canonical_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reports_pending_idx ON site.reports (created_at DESC) WHERE status = 'pending';

INSERT INTO public.schema_migrations (version, note)
VALUES (155, 'site.reports: reported_canonical_id, message_platform/message_id, resolved_by/resolved_at; reported_id nullable')
ON CONFLICT DO NOTHING;

COMMIT;
