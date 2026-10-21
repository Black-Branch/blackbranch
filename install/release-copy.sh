#!/usr/bin/env bash
# What a release is made of — ONE selection, used by install.sh (a checkout or an unpacked release
# copied onto the box) and by tools/release.mjs (the source tarball a signed release pins):
#
#   release-copy.sh <source tree> <destination>
#   release-copy.sh --forbidden < paths       the paths (one per line, relative to a tree's root)
#                                             that install/release-forbidden.txt refuses
#
# The product packages without their owner folders (the public cut), the shared config, this
# bundle, the baseline and every migration newer than the FIRST baseline ever released (an install
# may have started from it; migrate.sh skips what a database already records), the LICENSE (from
# the tree's root, or the private checkout's public-root/), and no .env file but .env.example. Never: agent instructions (CLAUDE.md, AGENTS.md), the bot's persona files
# (stream-ingest/config/ — install content, written at run time), or a file the source tree's
# private list names (ops/public-cut-exclude.txt: an owner's files that sit inside a product
# folder; a release or public tree has no such list and no such files). Prints how many files changed.
# The copy is then held to install/release-forbidden.txt — the list the public cut is held to — and
# refused, naming the files, when the selection let one through (an agent or editor folder nested
# in a package).
#
# The destination is never written in place: it may be the release a box runs (a repair), and a
# copy that is refused or cut short must not leave it holding the new source, a private file or
# half of either. The copy is made in a staging folder beside it (.<name>.copy: the same parent,
# so the renames stay on one filesystem; hidden, so a `releases/*/` loop never takes it for a
# release), checked there, and only then swapped in by two renames, .<name>.previous holding the
# old one between them. The staging folder starts as a full copy of the destination, so rsync's
# itemized changes are still the real delta and files outside the selection (a checkout's RELEASE)
# are kept as before. A full copy, not hard links (cp -al): rsync sets the times and mode of an
# unchanged file in place, and through a hard link that would reach the destination before the check.
# What each failure point leaves:
#   · refused, or stopped while copying or checking: the destination untouched; the staging folder
#     is removed by the exit trap, or after a SIGKILL by the next run;
#   · stopped between the two renames: the exit trap renames the old one back; after a SIGKILL the
#     destination is missing and .<name>.previous holds it whole, and the next run puts it back
#     before it copies (plain mv cannot exchange two directories in one step);
#   · stopped after the second rename: the destination is the complete new copy; the old one is
#     removed by the trap or by the next run.
set -euo pipefail
FORBIDDEN_LIST="$(dirname "${BASH_SOURCE[0]}")/release-forbidden.txt"
forbidden() { # the paths on stdin the list refuses
  local all line hits="" out=""
  [ -f "$FORBIDDEN_LIST" ] || { echo "release-copy: $FORBIDDEN_LIST is missing" >&2; exit 1; }
  all=$(cat)
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) ;;
      '!'*) hits=$(grep -Ev -- "${line#!}" <<<"$hits" || true) ;;
      *) out+="$hits"$'\n'; hits=$(grep -E -- "$line" <<<"$all" || true) ;;
    esac
  done < "$FORBIDDEN_LIST"
  printf '%s\n%s\n' "$out" "$hits" | sed '/^$/d' | LC_ALL=C sort -u
}
if [ "${1:-}" = --forbidden ]; then forbidden; exit 0; fi
# The version of the first baseline ever released: no install can have started from an older one,
# so the migration chain before it stays out of a release.
FIRST_BASELINE_VERSION=146

src="${1:?usage: release-copy.sh <source> <destination>}"; dest="${2:?usage: release-copy.sh <source> <destination>}"
if [ ! -f "$src/install/compose.yaml" ] || [ ! -d "$src/migrations/baseline" ]; then
  echo "release-copy: $src is not a release or checkout" >&2; exit 1
fi
grep -qm1 -E 'up to v[0-9]+' "$src/migrations/baseline/schema.sql" || { echo "release-copy: cannot read the baseline version" >&2; exit 1; }
# A release's RELEASE file (its version) travels with it; a checkout has none (install.sh writes one).
newer=()
if [ -f "$src/RELEASE" ]; then newer+=("--include=/RELEASE"); fi
licence=()
if [ -f "$src/LICENSE" ]; then licence+=("--include=/LICENSE"); fi
for f in "$src"/migrations/migrate-v*.sql; do
  [ -e "$f" ] || continue
  v=$(basename "$f" .sql); v="${v#migrate-v}"
  if [ "$v" -gt "$FIRST_BASELINE_VERSION" ]; then newer+=("--include=/migrations/migrate-v$v.sql"); fi
done
private=()
if [ -f "$src/ops/public-cut-exclude.txt" ]; then private+=("--exclude-from=$src/ops/public-cut-exclude.txt"); fi
# The agent, editor and build folders the forbidden list names "at any depth" (its lines that start
# `(^|/)(` or hold `(.+/)?(`, their last group) are left out wherever they sit — the selection is by
# top-level folder, and one nested in a package (web/.claude/, stream-api/.codex/) used to ride along
# until the check below refused the whole copy, or, for a name the list did not hold yet, shipped.
[ -f "$FORBIDDEN_LIST" ] || { echo "release-copy: $FORBIDDEN_LIST is missing" >&2; exit 1; }
nested=()
while IFS= read -r d; do [ -n "$d" ] && nested+=("--exclude=$d/"); done < <(
  grep -E '^\(\^\|/\)\(|\(\.\+/\)\?\(' "$FORBIDDEN_LIST" | grep -E '\)/$' | sed -E 's|.*\(([^()]*)\)/$|\1|' | tr '|' '\n' | sed 's/\\//g')
[ "${#nested[@]}" -ge 5 ] || { echo "release-copy: cannot read the nested folders from $FORBIDDEN_LIST" >&2; exit 1; }

dest="${dest%/}"; name=$(basename "$dest")
case "$name" in ''|.|..) echo "release-copy: \"$2\" names no folder of its own to copy into" >&2; exit 1 ;; esac
[ ! -L "$dest" ] || { echo "release-copy: $dest is a link; give the folder itself" >&2; exit 1; }
mkdir -p "$(dirname "$dest")"
dest="$(cd "$(dirname "$dest")" && pwd -P)/$name"
staging="$(dirname "$dest")/.$name.copy"; previous="$(dirname "$dest")/.$name.previous"
# The old destination beside a missing one is a swap cut between its renames: it goes back. Beside
# a present one, the swap finished and only removing the old one was cut short.
settle() {
  if [ -e "$previous" ]; then
    if [ -e "$dest" ]; then rm -rf "$previous"; else mv -T "$previous" "$dest"; fi
  fi
}
log=$(mktemp)
finish() {
  local rc=$?
  settle || rc=1
  rm -rf "$staging" "$log"
  exit "$rc"
}
trap finish EXIT
# Without these a signal ends bash without its EXIT trap.
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
settle
rm -rf "$staging"
if [ -d "$dest" ]; then cp -a -T "$dest" "$staging"; else mkdir "$staging"; fi
rsync -a --delete --checksum --itemize-changes \
  --exclude='node_modules/' --exclude='.next/' --exclude='.git' "${nested[@]}" \
  --include='.env.example' --exclude='.env*' --exclude='CLAUDE.md' --exclude='AGENTS.md' \
  --exclude='/stream-api/owner/' --exclude='/stream-ingest/owner/' --exclude='/web/app/(owner)/' \
  --exclude='/stream-ingest/config/' "${private[@]}" \
  --include='/config/***' --include='/install/***' --include='/stream-api/***' \
  --include='/stream-ingest/***' --include='/web/***' \
  --include='/migrations/' --include='/migrations/README.md' --include='/migrations/baseline/***' "${newer[@]}" \
  "${licence[@]}" --exclude='*' \
  "$src/" "$staging/" > "$log"
# The licence travels with every copy of the source: at the root of a public tree or a release, in
# public-root/ in the private checkout (the public repo's root files). Same itemized log, so a
# second copy of the same tree still counts no change (which is why the first rsync names /LICENSE
# only when the root has one: included but absent, its --delete would remove the copy made here).
if [ "${#licence[@]}" -eq 0 ] && [ -f "$src/public-root/LICENSE" ]; then
  rsync -a --checksum --itemize-changes "$src/public-root/LICENSE" "$staging/LICENSE" >> "$log"
fi
leaked=$(cd "$staging" && find . -mindepth 1 \( -type f -o -type l \) | sed 's|^\./||' | forbidden)
if [ -n "$leaked" ]; then printf 'release-copy: private files in the release:\n%s\n' "$leaked" >&2; exit 1; fi
if [ -e "$dest" ]; then mv -T "$dest" "$previous"; fi
mv -T "$staging" "$dest"
settle
echo "$(grep -c '^[<>c*]' "$log" || true) file(s) changed"
