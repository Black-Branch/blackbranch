-- v173: a retried chat send never posts the same line twice (site.chat_messages.client_msg_id).
--
-- The browser mints one id per composed line and sends it with every attempt at that line: its
-- own automatic retry after a timeout, a resend of the restored text, the "Not sent" retry. The
-- web send route answers a key it has already stored with the first row's id instead of posting
-- again, and stream-api's /chat/native INSERT names the key with ON CONFLICT DO NOTHING, so two
-- attempts racing each other still leave one row (the loser reads the winner's id back).
--
-- The unique index is the guard, so it has no time window: a key belongs to one line for life.
-- Partial, because every line from before this release, the bot's lines and the money cards carry
-- no key. On a new column every row is NULL, so the index starts empty and builds in one scan.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT EXISTS.
BEGIN;

ALTER TABLE site.chat_messages ADD COLUMN IF NOT EXISTS client_msg_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_client_msg_id
  ON site.chat_messages (matrix_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

COMMENT ON COLUMN site.chat_messages.client_msg_id IS
  'the sender''s own id for this line, minted by the browser per composed line; a send carrying a key already stored for the same sender is answered with that row, never posted again';

INSERT INTO public.schema_migrations (version, note)
VALUES (173, 'chat: site.chat_messages.client_msg_id, unique per sender, so a retried send replays instead of posting twice')
ON CONFLICT DO NOTHING;

COMMIT;
