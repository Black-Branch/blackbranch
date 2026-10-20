#!/usr/bin/env bash
# Helpers for the .env migrations beside this file, sourced by each NNN-*.sh. A
# migration rewrites the file named by $BB_ENV_FILE and nothing else: `blackbranch` runs every
# migration first on a COPY (the dry run an update starts with), and only then on the real .env.
# Each helper is safe to repeat, so a migration that ran halfway can run again.
#
# How to write one: install/migrations/README.md. Values are never printed.
set -euo pipefail
: "${BB_ENV_FILE:?BB_ENV_FILE (the .env to migrate) is required}"

envm_has() { grep -q -E "^$1=" "$BB_ENV_FILE"; }
# The new file replaces the old by a rename, and only once it is all there (no fewer lines than
# <fewest>, never empty): a full disk must leave .env as it was, never short. Each write checks its
# own status rather than trusting `set -e`, which a caller's `if`/`||` switches off.
envm_replace() { # envm_replace <tmp> <fewest lines>
  if [ ! -s "$1" ] || [ "$(wc -l < "$1")" -lt "$2" ] || ! mv -f "$1" "$BB_ENV_FILE"; then
    rm -f "$1"; echo "could not write $BB_ENV_FILE (is the disk full?) — it is as it was" >&2; return 1
  fi
}
envm_tmp() { mktemp "$(dirname "$BB_ENV_FILE")/.env.migrate.XXXXXX" || { echo "could not write $BB_ENV_FILE: no room for a temporary file" >&2; return 1; }; }
envm_get() { local l; l=$(grep -m1 -E "^$1=" "$BB_ENV_FILE" || true); printf '%s' "${l#*=}"; }
# The line is written as it was (already quoted for Compose), so a rename never re-quotes a value.
envm_put_line() { # envm_put_line KEY RAW — replace KEY's line, or append it
  local tmp lines
  tmp=$(envm_tmp) || return 1
  chmod 600 "$tmp"
  lines=$(wc -l < "$BB_ENV_FILE")
  if envm_has "$1"; then
    awk -v k="$1" -v line="$1=$2" 'index($0, k "=") == 1 { print line; next } { print }' "$BB_ENV_FILE" > "$tmp"
  else
    { cat "$BB_ENV_FILE" && printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  fi || { rm -f "$tmp"; echo "could not write $BB_ENV_FILE (is the disk full?) — it is as it was" >&2; return 1; }
  envm_replace "$tmp" "$lines"
}
# envm_add KEY VALUE — add KEY with VALUE when .env does not hold it (an existing value is kept).
envm_add() { envm_has "$1" || envm_put_line "$1" "$2"; }
# envm_rename OLD NEW — move OLD's value to NEW (NEW wins when both exist); OLD is removed.
envm_rename() {
  if envm_has "$1"; then
    envm_has "$2" || envm_put_line "$2" "$(envm_get "$1")" || return 1
    envm_drop "$1"
  fi
}
# envm_drop KEY — remove KEY (a retired setting).
envm_drop() {
  local tmp lines
  envm_has "$1" || return 0
  tmp=$(envm_tmp) || return 1
  chmod 600 "$tmp"
  lines=$(wc -l < "$BB_ENV_FILE")
  awk -v k="$1" 'index($0, k "=") != 1 { print }' "$BB_ENV_FILE" > "$tmp" \
    || { rm -f "$tmp"; echo "could not write $BB_ENV_FILE (is the disk full?) — it is as it was" >&2; return 1; }
  envm_replace "$tmp" "$((lines - 1))"
}
