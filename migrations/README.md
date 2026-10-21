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
