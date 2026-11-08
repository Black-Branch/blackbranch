-- v166: the permanent site bans a moderator lifted, for the community reconciler.
--
-- Spec 2026-10-23 community management §4.11: a permanent site ban is a room ban in every community
-- room (a timeout is level −1, never a room ban), and the reconciler lifts a room ban only for someone
-- the SITE unbanned (a ban made by hand in a room is the room's own and stays). site.bans holds one row
-- per person and a lift deletes it, so nothing recorded the lift. This log does: lifting a permanent
-- ban writes a row (lifting or ending a timeout never does); the reconciler's feed lists the people
-- lifted since its last successful apply run and prunes rows older than 30 days. No foreign key: like
-- the rest of the moderation record it outlives an account.
BEGIN;

CREATE TABLE IF NOT EXISTS site.community_unbans (
  matrix_id  text NOT NULL,
  lifted_at  timestamptz NOT NULL DEFAULT now(),
  lifted_by  text
);

CREATE INDEX IF NOT EXISTS community_unbans_lifted_at_idx ON site.community_unbans (lifted_at);

COMMENT ON TABLE site.community_unbans IS
  'Permanent site bans a moderator lifted (v166; a timeout is never recorded): the community reconciler lifts the room bans of the people listed since its last successful apply run. Rows older than 30 days are pruned.';

INSERT INTO public.schema_migrations (version, note)
VALUES (166, 'community_unbans: lifted site bans for the community reconciler')
ON CONFLICT DO NOTHING;

COMMIT;
