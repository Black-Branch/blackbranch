-- v158: an index for looking a chat line up by its handle on one platform.
--
-- Review round 5 made `!rank <name>` / `/user/lookup?platform=` answer for ONE platform account,
-- keyed by its handle (stream.chat_log carries no platform account id). When the name's first
-- owner (stream.nameidx) never chatted under it on the asking platform — a handle shared across
-- platforms, or a site name asked from a platform — stream-api profiles.js falls back to
--   SELECT user_id FROM stream.chat_log WHERE lower(username) = $1 AND lower(platform) = $2
--   ORDER BY created_at DESC LIMIT 1
-- which walked the whole table (≈380k rows, ≈130 ms measured on 2026-10-18), and any chatter can
-- type the command. This index answers it from the first matching row.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_chat_log_handle_platform
  ON stream.chat_log (lower(username), lower(platform), created_at DESC);

INSERT INTO public.schema_migrations (version, note)
VALUES (158, 'stream.chat_log index on (lower(username), lower(platform), created_at DESC) for per-platform handle lookups')
ON CONFLICT DO NOTHING;

COMMIT;
