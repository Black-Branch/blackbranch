-- v152 — the AI-memory opt-out outlives a deleted account.
--
-- site.memory_opt_outs is keyed on the site account (matrix_id) and goes with it when the account is
-- deleted. The person may keep chatting on a platform, and after the deletion those platform ids
-- start a FRESH chatter identity (stream-api account-erase.js) — which nothing marked as opted out,
-- so the bot would start remembering someone who had switched it off.
--
-- At erase, stream-api copies the opt-out onto every platform id the account was linked to. The
-- row is deliberately minimal: the platform and its id, nothing else — no name, no message, no
-- canonical id, no date. A row's presence IS the opt-out. stream-api memory.js reads it on the
-- embed path (live writer, /memory/allowed, the offline backfills); no public route returns it.

BEGIN;

CREATE TABLE IF NOT EXISTS stream.memory_opt_out_platform_ids (
  platform    TEXT NOT NULL,
  platform_id TEXT NOT NULL,
  PRIMARY KEY (platform, platform_id)
);

INSERT INTO public.schema_migrations (version, note)
VALUES (152, 'stream.memory_opt_out_platform_ids: a deleted account''s memory opt-out, kept by platform id only')
ON CONFLICT DO NOTHING;

COMMIT;
