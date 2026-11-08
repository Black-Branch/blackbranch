-- v174: a space's banner (site.community_spaces.banner_mxc).
--
-- The wide picture over the channel list, as Discord shows a server banner above its channels. The
-- Admin Panel's Community page sets it on the community itself; the reconciler writes it on the
-- space as the app.blackbranch.banner state event { url }, so every client, and a restore, sees it.
-- The space's m.room.avatar (avatar_mxc) stays its icon. NULL = no banner (the look before v174).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
BEGIN;

ALTER TABLE site.community_spaces ADD COLUMN IF NOT EXISTS banner_mxc text;

COMMENT ON COLUMN site.community_spaces.banner_mxc IS
  'the space''s banner (an mxc:// address), written on the space as app.blackbranch.banner by the reconciler; NULL = none';

INSERT INTO public.schema_migrations (version, note)
VALUES (174, 'community: site.community_spaces.banner_mxc, the banner over the channel list')
ON CONFLICT DO NOTHING;

COMMIT;
