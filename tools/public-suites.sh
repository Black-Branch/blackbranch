#!/usr/bin/env bash
# Every test suite of a public tree, run the way the public CI runs them — and the proof that no
# test needs a production database: DATABASE_URL and DB_PASSWORD are removed from the environment
# before anything starts.
#
#   tools/public-suites.sh [<tree>] [stream-api|stream-ingest|web|install]…   (default: all four)
#
# SUITES_DB_URL (optional): an EMPTY throwaway Postgres (pgvector) the database tests may use. It is
# filled the way an install fills its own — install/migrate.sh: the baseline, then every newer
# migration — and handed to the suites as SQL_PARSE_DATABASE_URL. It must be on this machine (or
# SUITES_DB_THROWAWAY=1) and hold no relation at all, or nothing runs. Without it those tests skip, as
# they do on a laptop; with CI set they refuse to (the public CI sets both).
set -euo pipefail

tree="$(cd "${1:-$(dirname "$0")/..}" && pwd)"
shift || true
suites=("$@")
[ "${#suites[@]}" -gt 0 ] || suites=(stream-api stream-ingest web install)

# No connection a shell may carry reaches the suites: only SUITES_DB_URL, checked below.
unset DATABASE_URL DB_PASSWORD SQL_PARSE_DATABASE_URL PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGPASSFILE
export PGPASSFILE=/dev/null
if [ -n "${SUITES_DB_URL:-}" ]; then
  # libpq's own variables, from the URL, for the migration runner (one value per line; no eval).
  mapfile -t pg < <(node -e '
    const u = new URL(process.argv[1]);
    for (const v of [u.hostname, u.port || "5432", decodeURIComponent(u.username), decodeURIComponent(u.password), u.pathname.slice(1)]) console.log(v);
  ' "$SUITES_DB_URL")
  export PGHOST="${pg[0]}" PGPORT="${pg[1]}" PGUSER="${pg[2]}" PGPASSWORD="${pg[3]}" PGDATABASE="${pg[4]}"
  # A throwaway is on this machine, and EMPTY: the suites write and delete rows, and migrate.sh would
  # happily take a database that already has its history. Anything else is refused before a query.
  case "$PGHOST" in localhost|127.0.0.1|::1|'[::1]') ;; *)
    [ "${SUITES_DB_THROWAWAY:-}" = "1" ] || { echo "public-suites: SUITES_DB_URL is not on this machine ($PGHOST) — set SUITES_DB_THROWAWAY=1 if it truly is a throwaway" >&2; exit 2; } ;;
  esac
  rel=$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')") \
    || { echo "public-suites: cannot reach SUITES_DB_URL" >&2; exit 2; }
  [ "$rel" = "0" ] || { echo "public-suites: SUITES_DB_URL is not an empty database ($rel relations) — the suites need a fresh throwaway" >&2; exit 2; }
  MIGRATIONS_DIR="$tree/migrations" bash "$tree/install/migrate.sh"
  export SQL_PARSE_DATABASE_URL="$SUITES_DB_URL"
fi

failed=()
for s in "${suites[@]}"; do
  echo "== suite: $s"
  case "$s" in
    stream-api|stream-ingest)
      (cd "$tree/$s" && { [ -d node_modules ] || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error; } && node --test) || failed+=("$s") ;;
    web)
      (cd "$tree/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund --loglevel=error; } && npm test) || failed+=("$s") ;;
    install)
      (cd "$tree" && node --test install/) || failed+=("$s") ;;
    *) echo "public-suites: unknown suite $s" >&2; exit 2 ;;
  esac
done
if [ "${#failed[@]}" -gt 0 ]; then echo "public-suites: failed: ${failed[*]}" >&2; exit 1; fi
echo "== every suite passed"
