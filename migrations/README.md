# migrations/

The database's schema changes, one file per version: `migrate-vN.sql`, applied in order, each in one
transaction, each recording itself in `public.schema_migrations`.

**Why the public repository starts at v147.** A new install never replays the whole history: it is
built from [`baseline/`](baseline/README.md) — the schema the history leaves, generated, plus the few
rows the product cannot run without — and then takes every migration newer than the baseline. The
first baseline ever released was v146, so an install may have started there; every migration after
it (v147 onward) is kept, because such an install still needs them. The older history the baseline
was generated from stays with the maintainers.

`../install/migrate.sh` is the runner: the baseline on an empty database, then each newer migration
the database does not record yet. A new migration lands in the same commit as a regenerated baseline,
and must apply both to a database built by the full history and to one that started from the
baseline — [`baseline/README.md`](baseline/README.md) has the rules and the check.

## Writing a migration

- **`public.schema_migrations` is the source of truth for what has been applied** — query it, never
  guess. (In the maintainers' full history it was created by v75, which back-filled every earlier
  version, so it answers from v2 onward; there is no v1 — the history's bootstrap file fills that slot.)
- **Every migration ends by recording itself:**
  `INSERT INTO public.schema_migrations (version, note) VALUES (…) ON CONFLICT DO NOTHING;`
- **Regenerate the baseline in the same commit:** `node tools/check-baseline.mjs --generate`
  rewrites `baseline/schema.sql` (generated — never hand-edited); `seed.sql` is hand-kept.
  `stream-api/baseline-gate.test.mjs` (Docker; fails, never skips, in CI) diffs chain against
  baseline and stays red until you do. The migration must apply to both.
- **Prove it rebuilds** (maintainers, full history): replay the bootstrap + every migration into a throwaway
  `pgvector/pgvector:pg18` container and diff `information_schema.columns` against the live
  database. That is how a migration's lost columns and another's silent failure were found. A
  column diff says WHICH columns differ, not why — anti-join `schema_migrations` before calling
  anything drift.
