-- v170: end the deleted-account restrictions that an old rule made permanent by mistake.
--
-- stream.erased_restrictions (v154/v156) is what a deleted account leaves on its platform ids. Until
-- c73b02e4 the site wrote reason 'ban' with NO end (expires_at NULL) for two different things: a
-- PERMANENT ban, and a TIMEOUT whose account had an open moderation case when it was deleted. The
-- second never ended — "Already linked" and a carried mark forever, and nothing pruned it. The rule
-- since then (web accountDeletion.ts restrictionExpiry): a timeout's restriction ends at the later of
-- the timeout's end and the case's end (30 days after the deletion — the held-message retention,
-- ADR 0104); a permanent ban's has no end until a moderator lifts the ban.
--
-- What a row holds decides it; nothing is invented:
--   • the account's site ban (site.bans keeps a deleted account's row) is still PERMANENT → the row
--     stays without an end (that is what it says);
--   • the account's site ban is a timeout → it ends at the later of the timeout's end and 30 days
--     after the deletion (created_at), exactly as the current rule would have written it;
--   • no site ban row at all (lifted — lifting deletes the row) → the case window only: 30 days after
--     the deletion. Whether a case was open is no longer knowable; the window is the most it could
--     have been, never a permanent restriction. A row already past it is pruned by the next daily run.
-- The same old rule wrote EVERY reason 'case' row (an open case, no ban) with no end too; the rule
-- since then ends a case with its evidence, 30 days after the deletion. Those rows get exactly that.
-- The chat hold (stream-api ban-hold.js) never read these ends: it follows site.bans itself.
-- Idempotent: a second run finds no row it changes (a corrected row has an end; a permanent ban's row
-- is skipped again).
BEGIN;

UPDATE stream.erased_restrictions r
   SET expires_at = GREATEST(
         COALESCE((SELECT max(b.expires_at) FROM site.bans b WHERE b.matrix_id = r.matrix_id), r.created_at),
         r.created_at + interval '30 days')
 WHERE r.reason = 'ban'
   AND r.expires_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM site.bans b WHERE b.matrix_id = r.matrix_id AND b.expires_at IS NULL);

UPDATE stream.erased_restrictions r
   SET expires_at = r.created_at + interval '30 days'
 WHERE r.reason = 'case'
   AND r.expires_at IS NULL;

INSERT INTO public.schema_migrations (version, note)
VALUES (170, 'stream.erased_restrictions: endless restrictions from deleted timeouts and cases get their end')
ON CONFLICT DO NOTHING;

COMMIT;
