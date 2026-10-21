-- v162: two column/table comments say what the thing is, without the maintainers' review notes.
--
-- A comment on a table or column is part of every install's database: `\d+` prints it. Two of them
-- named review findings a new install has never heard of. Same meaning, plain words. Comments only:
-- no data and no shape change.
BEGIN;

COMMENT ON TABLE public.schema_migrations IS
  'Which migrate-vN.sql have been applied. An install that started from the baseline holds one row per version up to it (note ''baseline''); applied_at is when the row was written, which for back-filled and baseline rows is not when the migration first ran.';

COMMENT ON COLUMN stream.support_events.admitted_usd IS
  'Amount of this credit the per-stream support bar and the timer admitted: its net after any refunds already recorded before it landed. NULL = the whole amount_usd.';

INSERT INTO public.schema_migrations (version, note)
VALUES (162, 'plain-language comments on schema_migrations and support_events.admitted_usd')
ON CONFLICT DO NOTHING;

COMMIT;
