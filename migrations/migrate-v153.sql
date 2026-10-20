-- v153 — a person shows their linked platforms on their profile only when they choose to.
--
-- The link between a person's accounts (this Twitch name is that site account, is that YouTube
-- channel) used to be public: the profile card returned the site account and the platform list for
-- any platform id, and the sponsor credit named a platform donation by the site account behind it.
-- Owner decision 2026-10-17: the link is shown only where the person shows it themselves — when they
-- post from the site to several platforms at once, or when they switch this on in Linked accounts.
-- Off by default for everyone, existing accounts included. Mods and the person themselves still see
-- the link either way. Read by web (/api/user/[id], the boards, the credit) and stream-api
-- (sponsors.js, the credit line's names).

BEGIN;

ALTER TABLE site.users ADD COLUMN IF NOT EXISTS show_links BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO public.schema_migrations (version, note)
VALUES (153, 'site.users.show_links: linked platforms shown on the profile only by the person''s own choice (default off)')
ON CONFLICT DO NOTHING;

COMMIT;
