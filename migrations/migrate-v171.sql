-- v171: the viewer census counts the Kick embed.
--
-- site.player_source_snapshots (v117) has one column per player a visitor can choose. The Kick embed
-- (decision 0135, the live row's fifth source) had none: a visitor watching it cast no vote, so the
-- mod "player sources" readout left them out, and one who switched to Kick stayed counted on the
-- source they left until that sample expired (90 s). Web writes `kick` from this release on
-- (sourceCensusStore.ts); rows written before it read 0, which is what they measured.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
BEGIN;

ALTER TABLE site.player_source_snapshots ADD COLUMN IF NOT EXISTS kick INTEGER NOT NULL DEFAULT 0;

INSERT INTO public.schema_migrations (version, note)
VALUES (171, 'viewer census: site.player_source_snapshots.kick for the Kick embed')
ON CONFLICT DO NOTHING;

COMMIT;
