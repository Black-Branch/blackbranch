-- Fresh-install SEEDS — the only rows a new install's database starts with.
--
-- Applied once, right after baseline/schema.sql. Each row is one the product cannot run
-- without, and each is NEUTRAL: it carries nothing but its key, and every other value is the
-- column default the schema already declares. A row that names a channel, a person, badge art,
-- a price, a bot, a domain or a network address is an install's own data and never goes here.
--
-- How this list was decided (measured, not guessed): replay the whole migration chain into an
-- empty database and list every table that ends up with rows, then decide each one — the
-- table is in migrations/baseline/README.md. tools/check-baseline.mjs proves that these are the
-- ONLY rows a fresh database holds, and that each equals the row the chain's own migration wrote.

-- Chat slow mode. The moderator setting is an UPDATE … WHERE id = 1; with no row it
-- persists nothing and slow mode silently never turns on.
INSERT INTO site.chat_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Lockdown posture (signups, cross-posting, account age, link gate). The link-gate setting is
-- an UPDATE … WHERE id = 1; with no row a moderator's change is silently dropped.
INSERT INTO site.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- The stream timer. stream-api writes it with an UPDATE … WHERE id = 1, so with no row the
-- timer never survives a restart.
INSERT INTO stream.timer_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
