#!/usr/bin/env bash
# The platform database's migration runner: one script for every install.
#
#   Empty database      → migrations/baseline/schema.sql + seed.sql, then every newer migration.
#   Database it made    → only the migrations it has not applied yet ("up to date" when none).
#   Anything else       → refuses (a schema with no schema_migrations is not ours to touch).
#
# Safe to run again and again: public.schema_migrations is the record of what was applied, and
# every migrate-vN.sql ends by inserting its own row there (a file that does not is a failure).
#
# Connection: the libpq variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD) name the role
# that OWNS the platform schema. Optional MIGRATE_ADMIN_USER / MIGRATE_ADMIN_PASSWORD name a
# superuser, used for one thing only: the baseline creates the `vector` extension and comments on
# it, which Postgres allows only a superuser or the extension's owner, and `vector` is not a
# trusted extension. So for the baseline alone the owning role is raised to superuser and lowered
# again — every object, the extensions included, ends up owned by that role, and the generated
# baseline is applied exactly as written. The role is lowered again on every run, whatever happened.
#
# MIGRATIONS_DIR (default /migrations) holds baseline/ and any migrate-vN.sql newer than it.
set -euo pipefail

dir="${MIGRATIONS_DIR:-/migrations}"
say() { printf '[migrate] %s\n' "$*"; }
die() { printf '[migrate] FAILED: %s\n' "$*" >&2; exit 1; }
q() { psql -X -q -v ON_ERROR_STOP=1 -At "$@"; }
apply() { psql -X -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }

: "${PGUSER:?PGUSER (the owning role) is required}"
if [ ! -f "$dir/baseline/schema.sql" ] || [ ! -f "$dir/baseline/seed.sql" ]; then die "no baseline in $dir/baseline"; fi

admin() { PGUSER="$MIGRATE_ADMIN_USER" PGPASSWORD="$MIGRATE_ADMIN_PASSWORD" q "$@"; }
lower_role() {
  [ -n "${MIGRATE_ADMIN_USER:-}" ] || return 0
  admin -c "ALTER ROLE \"$PGUSER\" NOSUPERUSER" || true
}

for _ in $(seq 1 60); do q -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
q -c 'SELECT 1' >/dev/null || die "cannot reach database ${PGDATABASE:-?} on ${PGHOST:-?} as $PGUSER"
lower_role

if [ "$(q -c "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" != "t" ]; then
  n=$(q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
            WHERE s.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')")
  [ "$n" = "0" ] || die "the database holds $n relations but no schema_migrations: not empty, and not one this runner made — refusing"
  say "empty database: applying the baseline"
  if [ -n "${MIGRATE_ADMIN_USER:-}" ]; then
    trap lower_role EXIT
    admin -c "ALTER ROLE \"$PGUSER\" SUPERUSER" >/dev/null
  fi
  # The schema and its seeds in ONE transaction. schema.sql records every version it holds in
  # schema_migrations, so a seed that failed after the schema had committed was never tried again —
  # every later run said "up to date", and lockdown, slow mode and the timer failed silently.
  apply --single-transaction -f "$dir/baseline/schema.sql" -f "$dir/baseline/seed.sql"
  lower_role
  trap - EXIT
  say "baseline applied: v$(q -c 'SELECT max(version) FROM public.schema_migrations') ($(q -c 'SELECT count(*) FROM public.schema_migrations') versions)"
fi

applied=" $(q -c 'SELECT string_agg(version::text, $$ $$) FROM public.schema_migrations') "
count=0
# Numeric order: a lexical sort runs v100 before v11.
for v in $(find "$dir" -maxdepth 1 -name 'migrate-v*.sql' -printf '%f\n' | sed 's/^migrate-v//; s/\.sql$//' | grep -E '^[0-9]+$' | sort -n); do
  case "$applied" in *" $v "*) continue ;; esac
  say "applying v$v"
  # One transaction: a migration that fails half-way leaves nothing of itself. A file's own BEGIN
  # only draws a warning, but its own COMMIT ENDS this transaction — whatever follows it runs
  # outside any. So a file's COMMIT must be its last statement: tools/check-migration-commit.mjs
  # holds every migration to that (CI's install job runs it).
  apply --single-transaction -f "$dir/migrate-v$v.sql"
  [ "$(q -c "SELECT count(*) FROM public.schema_migrations WHERE version = $v")" = "1" ] \
    || die "migrate-v$v.sql ran but recorded no schema_migrations row (every migration must insert its own)"
  count=$((count + 1))
done
# The seeds on every run, after the migrations (the schema they fill is this release's): each is
# ON CONFLICT DO NOTHING, so this adds only a row that is missing — a box whose seed failed under an
# older runner gets its rows back.
apply --single-transaction -f "$dir/baseline/seed.sql"
head=$(q -c 'SELECT max(version) FROM public.schema_migrations')
if [ "$count" = "0" ]; then say "up to date at v$head"; else say "applied $count migration(s); now at v$head"; fi
