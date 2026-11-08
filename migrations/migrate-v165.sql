-- v165: the community's desired state — spaces, rooms, roles, reconcile runs, and the Staff flag.
--
-- Spec: docs/superpowers/specs/2026-10-23-community-management-discord-design.md §4.2–§4.5. Until now
-- the community's shape (which spaces and channels exist, who can see and post in each) lived only
-- in Matrix room state, edited by hand. These tables are what the streamer WANTS; the reconciler
-- makes Matrix match them and records each pass in site.community_runs. The web model that reads
-- and validates them is web/app/lib/community/desired.ts.
--
-- No space or room rows: the hub row is written by the reconciler's first adopt, from the
-- install's hub room. The role ladder is seeded here; an install that started from the baseline
-- (whose seed holds singleton rows only) gets the same ladder from readDesired, which fills an
-- empty roles table.
BEGIN;

CREATE TABLE IF NOT EXISTS site.community_spaces (
  id             serial PRIMARY KEY,
  parent_id      integer REFERENCES site.community_spaces(id),
  kind           text NOT NULL CHECK (kind IN ('hub', 'category', 'gate')),
  name           text NOT NULL,
  topic          text,
  avatar_mxc     text,
  order_key      text NOT NULL,
  matrix_room_id text UNIQUE,
  gate_tier      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_spaces_parent_idx
  ON site.community_spaces (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS site.community_rooms (
  id                 serial PRIMARY KEY,
  space_id           integer NOT NULL REFERENCES site.community_spaces(id),
  kind               text NOT NULL CHECK (kind IN ('text', 'announcement', 'forum')),
  name               text NOT NULL,
  topic              text,
  avatar_mxc         text,
  order_key          text NOT NULL,
  see_rule           text NOT NULL DEFAULT 'everyone'
                     CHECK (see_rule IN ('everyone', 'supporters', 'mods', 'staff', 'invited')),
  post_rule          text NOT NULL DEFAULT 'everyone'
                     CHECK (post_rule IN ('everyone', 'supporters', 'staff', 'mods')),
  retention_days     integer CHECK (retention_days BETWEEN 1 AND 3650),
  encrypted          boolean NOT NULL DEFAULT false,
  published          boolean NOT NULL DEFAULT true,
  archived           boolean NOT NULL DEFAULT false,
  matrix_room_id     text UNIQUE,
  discord_channel_id text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_rooms_space_idx ON site.community_rooms (space_id);

-- level is not unique: Mod and Bot share 50 (spec §4.2); a role is known by its key.
CREATE TABLE IF NOT EXISTS site.community_roles (
  key       text PRIMARY KEY,
  label     text NOT NULL,
  level     integer NOT NULL,
  colour    text,
  hoist     boolean NOT NULL DEFAULT false,
  order_key text NOT NULL,
  builtin   boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS site.community_runs (
  id          serial PRIMARY KEY,
  mode        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  drift       jsonb,
  applied     jsonb,
  error       text
);

ALTER TABLE site.users ADD COLUMN IF NOT EXISTS is_staff boolean NOT NULL DEFAULT false;

-- The default ladder, top down. order_key uses the same scheme as orderKeyBetween (a0, a1, …),
-- and web/app/lib/community/desired.ts DEFAULT_ROLES carries the same rows.
INSERT INTO site.community_roles (key, label, level, colour, hoist, order_key, builtin) VALUES
  ('admin',     'Admin',     100, NULL, true,  'a0', true),
  ('staff',     'Staff',      75, NULL, true,  'a1', true),
  ('mod',       'Mod',        50, NULL, true,  'a2', true),
  ('bot',       'Bot',        50, NULL, true,  'a3', true),
  ('supporter', 'Supporter',  10, NULL, true,  'a4', true),
  ('member',    'Member',      0, NULL, false, 'a5', true),
  ('timeout',   'Timed out',  -1, NULL, false, 'a6', true)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE site.community_spaces IS
  'The community''s spaces as the streamer wants them (v165): the hub, its categories, and hidden tier gate spaces. matrix_room_id NULL = not created in Matrix yet.';
COMMENT ON TABLE site.community_rooms IS
  'The community''s channels as the streamer wants them (v165). see_rule/post_rule are the panel''s sentences; the reconciler turns them into join rules and power levels.';
COMMENT ON TABLE site.community_roles IS
  'The role ladder (v165): a label per power level. Matrix''s rule holds: a higher level can do everything a lower one can.';
COMMENT ON TABLE site.community_runs IS
  'One row per reconciler pass (v165): what drifted from the desired state and what was applied.';
COMMENT ON COLUMN site.community_rooms.retention_days IS
  'Days messages are kept; NULL = no per-channel limit. The install''s cap bounds it in the web model; 3650 is the hard ceiling.';
COMMENT ON COLUMN site.users.is_staff IS
  'The Staff role (v165, spec §4.2): moderate and edit channels, not roles, access, retention or encryption.';

INSERT INTO public.schema_migrations (version, note)
VALUES (165, 'community desired state') ON CONFLICT DO NOTHING;

COMMIT;
