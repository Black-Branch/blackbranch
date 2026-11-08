-- v176: a Discord server imported as the community (community plan, Slice 2 task 2.3).
--
-- The Admin Panel's Discord page reads a Discord server and proposes the community: each category a
-- nested space, each text and announcement channel a room, each role a rung of the ladder. What the
-- streamer confirms becomes ordinary rows. These columns and tables remember where each row came
-- from, so a second import proposes only what changed and never makes a row twice.
--
--   discord_import_id  the Discord category (spaces) or channel (rooms) a row was imported from.
--                      Not a link: site.community_rooms.discord_channel_id stays the one mark that
--                      a room is linked to Discord (the bridge's), which the reconciler acts on.
--   community_discord_import  the Discord server the community was imported from, and when.
--   community_discord_roles   how each Discord role was mapped onto the ladder at the last import,
--                      the streamer's own choices included, so the next import offers them again.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
BEGIN;

ALTER TABLE site.community_spaces ADD COLUMN IF NOT EXISTS discord_import_id text UNIQUE;
ALTER TABLE site.community_rooms ADD COLUMN IF NOT EXISTS discord_import_id text UNIQUE;

CREATE TABLE IF NOT EXISTS site.community_discord_import (
  guild_id     text PRIMARY KEY CHECK (guild_id ~ '^[0-9]{17,20}$'),
  guild_name   text NOT NULL,
  imported_at  timestamptz NOT NULL DEFAULT now(),
  imported_by  text
);

CREATE TABLE IF NOT EXISTS site.community_discord_roles (
  role_id     text PRIMARY KEY CHECK (role_id ~ '^[0-9]{17,20}$'),
  guild_id    text NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
  name        text NOT NULL,
  rung        text NOT NULL CHECK (rung IN ('admin', 'staff', 'mod', 'bot', 'supporter', 'member')),
  source      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN site.community_spaces.discord_import_id IS
  'the Discord category this space was imported from (v176); NULL = not imported. A second import matches on it.';
COMMENT ON COLUMN site.community_rooms.discord_import_id IS
  'the Discord channel this room was imported from (v176); NULL = not imported. Not a link: discord_channel_id is.';
COMMENT ON TABLE site.community_discord_import IS
  'The Discord server the community was imported from (v176), one row per server, and the last import.';
COMMENT ON TABLE site.community_discord_roles IS
  'Each Discord role''s rung on the ladder as the last import confirmed it (v176); source names a Supporter role''s origin (booster, a linked platform, a bot by name).';

INSERT INTO public.schema_migrations (version, note)
VALUES (176, 'community: Discord import (discord_import_id, community_discord_import, community_discord_roles)')
ON CONFLICT DO NOTHING;

COMMIT;
