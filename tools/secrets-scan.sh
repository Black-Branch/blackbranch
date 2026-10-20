#!/usr/bin/env bash
# Secrets scan of a directory with gitleaks — pinned by version AND by the sha256 of its release
# archive, so a re-published release cannot change what runs here.
#
#   tools/secrets-scan.sh <dir>
#
# The rules are gitleaks' own defaults plus <dir>/.gitleaks.toml (its allowlist: each entry says why
# a match is not a secret). Inline `gitleaks:allow` comments are IGNORED, so a finding can only be
# waved through in that one reviewed file. Findings are printed redacted; exit 1 on any.
# GITLEAKS_CACHE (default ~/.cache/gitleaks-<version>) keeps the downloaded archive between runs;
# its checksum is checked again on every run.
set -euo pipefail

VERSION=8.30.1
SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb   # gitleaks_8.30.1_linux_x64.tar.gz
ARCHIVE="gitleaks_${VERSION}_linux_x64.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}"

dir="${1:?usage: tools/secrets-scan.sh <dir>}"
[ -d "$dir" ] || { echo "secrets-scan: $dir is not a directory" >&2; exit 2; }
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "secrets-scan: the pinned gitleaks build is linux x86-64 only" >&2; exit 2; }

cache="${GITLEAKS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/gitleaks-$VERSION}"
mkdir -p "$cache"
if [ ! -f "$cache/$ARCHIVE" ]; then
  curl -fsSL --proto '=https' --proto-redir '=https' -o "$cache/$ARCHIVE.part" "$URL"
  mv "$cache/$ARCHIVE.part" "$cache/$ARCHIVE"
fi
if ! echo "$SHA256  $cache/$ARCHIVE" | sha256sum -c --status; then
  rm -f "$cache/$ARCHIVE"
  echo "secrets-scan: $ARCHIVE does not match its pinned sha256 — removed; refusing to run it" >&2
  exit 1
fi
bin="$(mktemp -d)"
trap 'rm -rf "$bin"' EXIT
tar -xzf "$cache/$ARCHIVE" -C "$bin" gitleaks

config=()
if [ -f "$dir/.gitleaks.toml" ]; then config=(--config "$dir/.gitleaks.toml"); fi
"$bin/gitleaks" dir "$dir" "${config[@]}" --no-banner --redact --verbose --ignore-gitleaks-allow --exit-code 1 --log-level warn
echo "secrets-scan: ok — gitleaks $VERSION found nothing in $dir"
