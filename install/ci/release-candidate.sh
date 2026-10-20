#!/usr/bin/env bash
# The release-candidate rehearsal (spec 2026-10-10-black-branch-phase-6-fresh-install-design.md §7.5):
# on a fresh machine, cut real signed releases from one tree with a throwaway key, install the first
# with the published one-line form, update to the second, and prove that a third whose health check
# fails is rolled back. The workflow .github/workflows/release-candidate.yml calls one step at a
# time; each step can also be run by hand on a throwaway VM (Debian or Ubuntu with Docker, sudo and
# node; NEVER a box that runs a real install: it installs into /opt/blackbranch).
#
#   release-candidate.sh prepare <tree>   a test signing key, the tree copied with that key as the one
#                                         it trusts, a local registry and the site's image pushed to it
#                                         (one image for every release here), the third-party digests,
#                                         a local feed server, the test domain resolving to this machine
#   release-candidate.sh cut A|B|C        cut and publish a release to the feed: A from the tree, B with
#                                         one changed file, C whose stream-api closes every viewer's
#                                         socket (its update health check must fail)
#   release-candidate.sh tree B|C         only make that release's tree from A's (cut does it too)
#   release-candidate.sh install          the stamped one-line form: curl … | sudo bash -s -- …
#   release-candidate.sh check-install    every service healthy, the setup page and the homeserver
#                                         answer, the first setup step (the first admin) through the
#                                         site's own API, the update health check passes, and a second
#                                         run of the one-line form changes nothing
#   release-candidate.sh update-good      blackbranch update --apply B → the box runs B, healthy
#   release-candidate.sh update-bad       blackbranch update --apply C → rolled back to B, healthy
#   release-candidate.sh usage start|report   peak memory in use and the least disk free, sampled
#   release-candidate.sh versions         the three versions (from RC_TAG: v1.2.3 → 1.2.3-ci.1 …)
#   release-candidate.sh logs             what to read when a step failed
#
# Everything lives in RC_WORK (default $RUNNER_TEMP/bb-rc): the key, the trees, the feed, the logs.
# The key is made for this run and thrown away with the machine; it signs nothing anyone else trusts.
# Test hooks (install/ci/release-candidate.test.mjs): RC_BOX (the install's folder, default
# /opt/blackbranch), RC_SUDO (default sudo; "" runs the box's commands as this user).
set -euo pipefail

W="${RC_WORK:-${RUNNER_TEMP:-/tmp}/bb-rc}"
BOX="${RC_BOX:-/opt/blackbranch}"
SUDO="${RC_SUDO-sudo}"
DOMAIN="${RC_DOMAIN:-bb.test}"
SITE_NAME="${RC_SITE_NAME:-RC Install}"
FEED_PORT="${RC_FEED_PORT:-8712}"
FEED="http://127.0.0.1:$FEED_PORT"
REGISTRY_PORT="${RC_REGISTRY_PORT:-5000}"
# The local registry the site's image is pushed to and every install here pulls from (Docker treats a
# registry on localhost as plain http without any setting). Pinned like every image the bundle uses.
REGISTRY_IMAGE="registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373"
WEB_REPO="localhost:$REGISTRY_PORT/blackbranch/web"
ADMIN=rcadmin
# The one line C adds: stream-api's WebSocket server closes every viewer's socket (the update health
# check's probe is one) and keeps its internal ones. Not every socket: stream-ingest's internal socket
# is the only thing that keeps that process running on an install with no platform set up, so a C that
# closed it too failed at "not every service became healthy" (stream-ingest restarting), not at the
# probe — found on the first full run of this rehearsal.
WS_ANCHOR="    ws.internal = Boolean(req && req.headers && isInternalUpgrade(req.headers));"
WS_BREAK="    if (!ws.internal) { ws.close(1011, 'release candidate C: broken on purpose'); return; }"
MARKER_FILE=install/ci/RC-MARKER

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\033[31mrelease-candidate: %s\033[0m\n' "$*" >&2; exit 1; }
box()  { if [ -n "$SUDO" ]; then "$SUDO" "$@"; else "$@"; fi; }

# ── versions ─────────────────────────────────────────────────────────────────────────────────
# A tag v1.2.3 rehearses as 1.2.3-ci.1 → -ci.2 → -ci.3 (a pre-release of the tag, ordered by number);
# a manual run without a tag as 0.0.0-ci.N. Never the tag's own version: these releases are signed
# by a throwaway key and must never be mistaken for the real one.
versions() {
  local tag="${RC_TAG:-}" v sep=-
  v="${tag#v}"
  if [ -z "$tag" ] || [ "$tag" = "$v" ] || ! [[ "$v" =~ ^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})(-[0-9a-z-]+(\.[0-9a-z-]+)*)?$ ]]; then
    v=0.0.0
  elif [[ "$v" == *-* ]]; then sep=.; fi
  printf '%s%sci.1 %s%sci.2 %s%sci.3\n' "$v" "$sep" "$v" "$sep" "$v" "$sep"
}
version_of() { # version_of A|B|C
  local a b c; read -r a b c <<<"$(versions)"
  case "$1" in A) echo "$a" ;; B) echo "$b" ;; C) echo "$c" ;; *) die "a release is A, B or C" ;; esac
}

# ── the box, read ────────────────────────────────────────────────────────────────────────────
env_of() { box grep -m1 -E "^$1=" "$BOX/.env" | sed -E 's/^[^=]*=//; s/^"//; s/"$//'; }
last_update() { box cat "$BOX/results/update-last.json"; }
jget() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=j[process.argv[1]]; process.stdout.write(v===undefined||v===null?"":String(v))' "$1"; }

# expect_runs <version> — the box runs exactly this release: .env, the release pointer, its RELEASE file.
expect_runs() {
  local v="$1" got
  got=$(env_of BB_RELEASE); [ "$got" = "$v" ] || die ".env BB_RELEASE is \"$got\", expected $v"
  got=$(box readlink "$BOX/release"); [ "$got" = "releases/$v" ] || die "release points at \"$got\", expected releases/$v"
  got=$(box head -1 "$BOX/release/RELEASE"); [ "$got" = "$v" ] || die "the release in use names itself \"$got\", expected $v"
  info "the box runs $v (.env, the release pointer and its RELEASE file agree)"
}
# expect_last <result> <from> <to> — the update's own record (results/update-last.json).
expect_last() {
  local j r f t
  j=$(last_update) || die "no results/update-last.json: the update recorded nothing"
  r=$(jget result <<<"$j"); f=$(jget from <<<"$j"); t=$(jget to <<<"$j")
  if ! { [ "$r" = "$1" ] && [ "$f" = "$2" ] && [ "$t" = "$3" ]; }; then
    die "the last update says result=$r from=$f to=$t; expected $1 from $2 to $3 ($(jget message <<<"$j"))"
  fi
  info "the update recorded: $r, $f → $t — $(jget message <<<"$j")"
}
expect_health() { # the update's own health check, run by hand: exit 0 and every probe that ran passed
  local out rc=0 line
  out=$(box blackbranch health 2>&1) || rc=$?
  printf '%s\n' "$out" | { grep -v '^BBHEALTH ' || true; } | sed 's/^/   | /'
  line=$(printf '%s\n' "$out" | sed -n 's/^BBHEALTH //p' | tail -1)
  if ! { [ "$rc" = 0 ] && [[ "$line" == '{"ok":true,'* ]]; }; then
    die "blackbranch health failed (exit $rc): ${line:-no BBHEALTH line}"
  fi
  # With the first admin made, the sign-in probe has an account: "not checked" would be a hole here.
  if [ -n "${1:-}" ] && ! [[ "$line" == *'"whoami":{"ok":true'* ]]; then die "the health check did not sign the first admin in (whoami not ok): $line"; fi
  info "blackbranch health: ok"
}
expect_status() { # blackbranch status: exit 0 (every service healthy) and the release named
  local out rc=0
  out=$(box blackbranch status 2>&1) || rc=$?
  printf '%s\n' "$out" | sed 's/^/   | /'
  [ "$rc" = 0 ] || die "blackbranch status: not every service is healthy (exit $rc)"
  grep -qE "^  release +$1 " <<<"$out" || die "blackbranch status does not name release $1"
  if [ -n "${2:-}" ]; then grep -qF "first admin: $2" <<<"$out" || die "blackbranch status does not show the first admin $2 (the data did not survive)"; fi
}

# ── usage ────────────────────────────────────────────────────────────────────────────────────
# Sampled every 2 s for the whole run: memory in use (MemTotal − MemAvailable), swap, and the free
# disk where Docker keeps its data. The report prints the peaks.
usage() {
  case "${1:-}" in
    start)
      mkdir -p "$W"
      if [ -f "$W/usage.pid" ] && kill -0 "$(cat "$W/usage.pid")" 2>/dev/null; then return 0; fi
      # shellcheck disable=SC2016 # the sampler's own script: expanded by the bash it starts, not here
      setsid bash -c 'root=$(docker info -f "{{.DockerRootDir}}" 2>/dev/null || echo /); [ -d "$root" ] || root=/
        while :; do
          m=$(awk "/^MemTotal:/{t=\$2} /^MemAvailable:/{a=\$2} /^SwapTotal:/{st=\$2} /^SwapFree:/{sf=\$2} END{printf \"%d %d %d\", (t-a)/1024, a/1024, (st-sf)/1024}" /proc/meminfo)
          d=$(df -Pk "$root" 2>/dev/null | awk "NR==2{printf \"%d\", \$4/1024}")
          echo "$(date +%s) $m ${d:-0}"; sleep 2
        done' >> "$W/usage.log" 2>/dev/null < /dev/null &
      echo $! > "$W/usage.pid"; info "sampling memory and disk every 2 s ($W/usage.log)" ;;
    report)
      [ -s "$W/usage.log" ] || { info "no usage samples"; return 0; }
      awk 'NR==1{mu=$2; ma=$3; sw=$4; df=$5; t0=$1} {if($2>mu)mu=$2; if($3<ma)ma=$3; if($4>sw)sw=$4; if($5<df)df=$5; t=$1}
           END{printf "   usage over %d s: memory in use at most %d MiB, MemAvailable at least %d MiB, swap at most %d MiB, least disk free %d MiB\n", t-t0, mu, ma, sw, df}' "$W/usage.log" ;;
    *) die "usage start|report" ;;
  esac
}

# ── prepare ──────────────────────────────────────────────────────────────────────────────────
wait_url() { # wait_url <url> <seconds>
  local end=$(( $(date +%s) + $2 ))
  until curl -fsS -o /dev/null "$1" 2>/dev/null; do [ "$(date +%s)" -lt "$end" ] || return 1; sleep 1; done
}
prepare() {
  local src="${1:?prepare <tree>}" a b c out d v
  if ! { [ -f "$src/install/compose.yaml" ] && [ -f "$src/tools/release.mjs" ]; }; then
    die "$src is not a release tree (no install/compose.yaml or tools/release.mjs)"
  fi
  [ ! -e "$W/key" ] || die "$W already holds a rehearsal's key: start again with a new RC_WORK (and a fresh machine)"
  read -r a b c <<<"$(versions)"
  mkdir -p "$W"; usage start
  say "A throwaway signing key, and the tree trusting it ($a, $b, $c)"
  node "$src/tools/release.mjs" keygen --out "$W/key"
  rm -rf "$W/tree-A"; mkdir -p "$W/tree-A"
  rsync -a --exclude=.git/ --exclude=node_modules/ --exclude=.next/ "$src/" "$W/tree-A/"
  cp "$W/key/release-key.pub" "$W/tree-A/install/release-key.pub"
  info "tree: $W/tree-A ($(find "$W/tree-A" -type f | wc -l) files), trusting $(cat "$W/key/release-key.pub")"

  say "The test domain resolves to this machine"
  if ! grep -qE "^127\.0\.0\.1 $DOMAIN api\.$DOMAIN matrix\.$DOMAIN\$" /etc/hosts; then
    echo "127.0.0.1 $DOMAIN api.$DOMAIN matrix.$DOMAIN" | box tee -a /etc/hosts >/dev/null
  fi
  [[ "$(getent hosts "matrix.$DOMAIN")" == '127.0.0.1 '* ]] || die "matrix.$DOMAIN does not resolve to 127.0.0.1"

  say "A local registry, and the feed served from $W/feed"
  docker rm -f bb-rc-registry >/dev/null 2>&1 || true
  docker run -d --name bb-rc-registry -p "127.0.0.1:$REGISTRY_PORT:5000" "$REGISTRY_IMAGE" >/dev/null
  wait_url "http://127.0.0.1:$REGISTRY_PORT/v2/" 60 || die "the local registry did not answer"
  mkdir -p "$W/feed"
  if [ -f "$W/feed.pid" ]; then kill "$(cat "$W/feed.pid")" 2>/dev/null || true; fi
  setsid python3 -m http.server "$FEED_PORT" --bind 127.0.0.1 --directory "$W/feed" > "$W/feed.log" 2>&1 < /dev/null &
  echo $! > "$W/feed.pid"
  wait_url "$FEED/" 30 || die "the feed server did not answer on $FEED"
  info "registry localhost:$REGISTRY_PORT, feed $FEED"

  say "The site's image: built once from the tree, pushed, tagged for each release"
  local t0; t0=$(date +%s)
  out=$(node "$W/tree-A/tools/release.mjs" image --version "$a" --tree "$W/tree-A" --web-image "$WEB_REPO" --push 2>&1 | tee "$W/image.log" | tail -1) \
    || { tail -40 "$W/image.log"; die "the site's image did not build or push"; }
  d=$(sed -nE 's/^pushed [^@]+@(sha256:[0-9a-f]{64}) .*/\1/p' <<<"$out")
  [ -n "$d" ] || die "no digest in: $out"
  info "built and pushed in $(( $(date +%s) - t0 )) s: $WEB_REPO@$d ($(docker image inspect "$WEB_REPO:$a" -f '{{.Size}}') bytes)"
  for v in "$b" "$c"; do
    docker tag "$WEB_REPO:$a" "$WEB_REPO:$v"
    docker push -q "$WEB_REPO:$v" >/dev/null
  done
  # Every release pins the same image: a pushed tag that resolved to another digest is a failure here.
  for v in "$a" "$b" "$c"; do
    out=$(curl -fsSI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
      "http://127.0.0.1:$REGISTRY_PORT/v2/blackbranch/web/manifests/$v" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p')
    [ "$out" = "$d" ] || die "$WEB_REPO:$v is $out in the registry, not $d"
  done
  echo "$d" > "$W/web-digest"
  # The install must PULL the site's image, as a real box does: nothing of it stays on this machine.
  docker image rm "$WEB_REPO:$a" "$WEB_REPO:$b" "$WEB_REPO:$c" >/dev/null
  if docker image inspect "$WEB_REPO@$d" >/dev/null 2>&1; then docker image rm "$WEB_REPO@$d" >/dev/null 2>&1 || true; fi

  say "The third-party images' digests, looked up once (every release here pins the same ones)"
  node "$W/tree-A/tools/release.mjs" digests --tree "$W/tree-A" --out "$W/digests.json"
  # shellcheck disable=SC2016 # JavaScript, not shell
  node -e 'const fs=require("fs"); const [f, repo, d, ...vs]=process.argv.slice(1); const t=JSON.parse(fs.readFileSync(f,"utf8"));
    for (const v of vs) t[`${repo}:${v}`]=d; fs.writeFileSync(f, JSON.stringify(t,null,2)+"\n");' "$W/digests.json" "$WEB_REPO" "$d" "$a" "$b" "$c"
  sed 's/^/   /' "$W/digests.json"
}

# ── cut ──────────────────────────────────────────────────────────────────────────────────────
# make_tree B|C — B: A's tree and one changed file; C: B's tree with stream-api's socket broken.
make_tree() {
  local which="$1" from n
  case "$which" in A) return 0 ;; B) from=A ;; C) from=B ;; *) die "a release is A, B or C" ;; esac
  [ -d "$W/tree-$from" ] || make_tree "$from"
  rm -rf "$W/tree-$which"; cp -a "$W/tree-$from" "$W/tree-$which"
  case "$which" in
    B) printf 'release candidate rehearsal: tree B (%s)\n' "$(version_of B)" > "$W/tree-B/$MARKER_FILE" ;;
    C)
      n=$(grep -cxF "$WS_ANCHOR" "$W/tree-C/stream-api/ws-hub.js" || true)
      [ "$n" = 1 ] || die "stream-api/ws-hub.js has $n lines \"$WS_ANCHOR\" (expected 1): release C cannot be broken where the health check looks — update WS_ANCHOR"
      WS_BREAK="$WS_BREAK" awk -v a="$WS_ANCHOR" '{ print } $0 == a { print ENVIRON["WS_BREAK"] }' "$W/tree-B/stream-api/ws-hub.js" > "$W/tree-C/stream-api/ws-hub.js"
      [ "$(grep -cxF "$WS_BREAK" "$W/tree-C/stream-api/ws-hub.js")" = 1 ] || die "release C's break did not apply" ;;
  esac
}
cut_release() {
  local which="$1" v prev
  v=$(version_of "$which")
  if ! { [ -f "$W/key/release-signing.key" ] && [ -s "$W/digests.json" ]; }; then die "run prepare first"; fi
  make_tree "$which"
  # A feed is newer than the last one only by its `published` second: never cut two in one second.
  prev=$(stat -c %Y "$W/feed/stable.json" 2>/dev/null || echo 0)
  while [ "$(date +%s)" -le "$prev" ]; do sleep 1; done
  say "Cutting release $which ($v)"
  node "$W/tree-$which/tools/release.mjs" cut --version "$v" --channel stable --key "$W/key/release-signing.key" --out "$W/feed" \
    --tree "$W/tree-$which" --digests "$W/digests.json" --web-image "$WEB_REPO" --base-url "$FEED" \
    --notes "Release candidate rehearsal: release $which." | sed 's/^/   /'
  node "$W/tree-$which/tools/release.mjs" verify --feed "$W/feed/stable.json" --key "$W/key/release-key.pub" | sed 's/^/   /'
  grep -q "^BOOTSTRAP_VERSION=\"$v\"\$" "$W/feed/install.sh" || die "the one-line installer is not stamped with $v"
}

# ── install ──────────────────────────────────────────────────────────────────────────────────
one_line() { # the published form, exactly as an operator types it (the feed's install.sh, piped)
  curl -fsSL "$FEED/install.sh" | box bash -s -- --domain "$DOMAIN" --mode internal --site-name "$SITE_NAME" \
    --release-key "$W/key/release-key.pub" --no-swap
}
install_box() {
  local a t0 rc=0 d
  a=$(version_of A); d=$(cat "$W/web-digest")
  [ ! -e "$BOX/.env" ] || die "$BOX already holds an install: this runs on a fresh machine only"
  ! docker image inspect "$WEB_REPO@$d" >/dev/null 2>&1 || die "the site's image is already on this machine: the install would not pull it"
  grep -q "^BOOTSTRAP_VERSION=\"$a\"\$" "$W/feed/install.sh" || die "the feed's install.sh is not release A's (cut A first)"
  say "curl -fsSL $FEED/install.sh | sudo bash -s -- --domain $DOMAIN --mode internal --site-name \"$SITE_NAME\" --release-key … --no-swap"
  t0=$(date +%s)
  # Its output, minus the setup link (the link is the way in to the first admin: never in a log).
  set +e; one_line 2>&1 | tee "$W/install-1.log" | grep -v 'setup?token='; rc=${PIPESTATUS[0]}; set -e
  info "the one-line install: exit $rc in $(( $(date +%s) - t0 )) s"
  [ "$rc" = 0 ] || die "the one-line install failed (exit $rc)"
  grep -q "Fetching release $a" "$W/install-1.log" || die "the installer did not fetch release $a"
  grep -q "setup?token=" "$W/install-1.log" || die "the install printed no setup link"
}

# ── first boot ───────────────────────────────────────────────────────────────────────────────
box_snapshot() { # what a second run must leave as it was: .env, the release, every container
  box sha256sum "$BOX/.env" | cut -d' ' -f1
  box readlink "$BOX/release"
  box docker ps -a --no-trunc --format '{{.Names}} {{.ID}} {{.Image}}' | grep -v ' bb-rc-registry ' | LC_ALL=C sort
}
# page_has <url> <text> — read whole, then matched: `curl | grep -q` fails under pipefail when grep
# stops reading first (curl: (23) on the first run of this rehearsal).
page_has() { local body; body=$(curl -fsSk "$1") || return 1; grep -qF -- "$2" <<<"$body"; }
check_install() {
  local a pub tok pw out before after t0 rc=0
  a=$(version_of A); pub=$(cat "$W/key/release-key.pub")
  say "Release A ($a) runs, every service healthy"
  expect_runs "$a"
  expect_status "$a"
  [ "$(env_of BB_UPDATE_FEED)" = "$FEED" ] || die ".env BB_UPDATE_FEED is not the feed the one-line form came from"
  [ "$(env_of BB_RELEASE_KEY)" = "$pub" ] || die ".env BB_RELEASE_KEY is not the test key"
  out=$(box docker inspect -f '{{.Config.Image}}' "$(box docker compose --project-directory "$BOX" ps -q web)")
  [ "$out" = "$WEB_REPO:$a@$(cat "$W/web-digest")" ] || die "web runs $out, not the release's pinned image"
  info "the site runs the pinned image, pulled from the registry"

  say "The setup page and the homeserver answer"
  page_has "https://$DOMAIN/setup" "$SITE_NAME" || die "https://$DOMAIN/setup does not answer with the site's name"
  page_has "https://matrix.$DOMAIN/_matrix/client/versions" '"versions"' || die "the homeserver's versions do not answer"
  page_has "https://matrix.$DOMAIN/_matrix/client/v1/auth_metadata" "\"issuer\":\"https://matrix.$DOMAIN/auth/\"" \
    || die "the homeserver's sign-in metadata does not name its account server"
  info "https://$DOMAIN/setup, https://matrix.$DOMAIN versions and auth_metadata answer"

  say "Setup's first step through the site's own API: the first admin (the later steps sign in with a browser)"
  tok=$(box cat "$BOX/state/setup-token")
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$tok"; fi
  pw=$(openssl rand -hex 16)
  out=$(curl -sSk -X POST "https://$DOMAIN/api/setup/admin" -H "Origin: https://$DOMAIN" -H 'Content-Type: application/json' \
    --data-binary @- <<<"{\"token\":\"$tok\",\"username\":\"$ADMIN\",\"password\":\"$pw\"}")
  [[ "$out" == *"\"matrixId\":\"@$ADMIN:$DOMAIN\""* ]] || die "the first admin was not made: $out"
  out=$(box blackbranch setup-link 2>&1 || true)
  grep -qF "first admin (@$ADMIN:$DOMAIN) exists" <<<"$out" || die "the setup link still works after the first admin: $out"
  info "@$ADMIN:$DOMAIN made; the setup link is retired"
  expect_health admin

  say "A second run of the one-line form changes nothing"
  before=$(box_snapshot)
  t0=$(date +%s)
  one_line > "$W/install-2.log" 2>&1 || rc=$?
  info "second run: exit $rc in $(( $(date +%s) - t0 )) s"
  [ "$rc" = 0 ] || { grep -v 'setup?token=' "$W/install-2.log" | tail -40; die "the second run failed (exit $rc)"; }
  ! grep -q 'Fetching release' "$W/install-2.log" || die "the second run fetched the release again"
  after=$(box_snapshot)
  if [ "$before" != "$after" ]; then diff <(echo "$before") <(echo "$after") | sed 's/^/   /' || true; die "the second run changed .env, the release or a container"; fi
  info ".env, the release pointer and every container are as they were"
  expect_status "$a" "@$ADMIN:$DOMAIN"
}

# ── updates ──────────────────────────────────────────────────────────────────────────────────
run_update() { # run_update <version> <log> → the update's exit status
  local rc=0 t0; t0=$(date +%s)
  box blackbranch update --check 2>&1 | sed 's/^/   | /' || true
  box blackbranch update --apply "$1" > "$2" 2>&1 || rc=$?
  sed 's/^/   | /' "$2"
  info "blackbranch update --apply $1: exit $rc in $(( $(date +%s) - t0 )) s"
  return "$rc"
}
update_good() {
  local a b rc=0
  a=$(version_of A); b=$(version_of B)
  say "Update A ($a) → B ($b), the named-release path"
  run_update "$b" "$W/update-B.log" || rc=$?
  [ "$rc" = 0 ] || die "the update to $b failed (exit $rc)"
  expect_last updated "$a" "$b"
  expect_runs "$b"
  box cmp -s "$W/tree-B/$MARKER_FILE" "$BOX/release/$MARKER_FILE" || die "the release in use does not hold B's changed file"
  info "B's changed file is in the release in use"
  expect_status "$b" "@$ADMIN:$DOMAIN"
  expect_health admin
}
update_bad() {
  local b c rc=0 out
  b=$(version_of B); c=$(version_of C)
  say "Update B ($b) → C ($c), whose health check must fail: the box goes back to B"
  run_update "$c" "$W/update-C.log" || rc=$?
  [ "$rc" != 0 ] || die "the update to $c exited 0: a release that fails its health check must not report success"
  grep -q "ROLLED BACK: $c" "$W/update-C.log" || die "the update did not say it rolled back"
  grep -q 'the socket closed before a frame' "$W/update-C.log" || die "C failed, but not where it was broken (the WebSocket probe)"
  expect_last rolled-back "$b" "$c"
  expect_runs "$b"
  out=$(box docker inspect -f '{{.Config.Image}}' "$(box docker compose --project-directory "$BOX" ps -q stream-api)")
  [ "$out" = "blackbranch/stream-api:$b" ] || die "stream-api runs $out after the rollback, not B's"
  expect_status "$b" "@$ADMIN:$DOMAIN"
  expect_health admin
}

logs() {
  box docker compose --project-directory "$BOX" ps -a 2>&1 || true
  box docker compose --project-directory "$BOX" logs --no-color --tail 150 2>&1 || true
  for f in update-last.json update-state.json update-feed.json; do echo "--- results/$f"; box cat "$BOX/results/$f" 2>/dev/null || true; done
  for f in install-1.log install-2.log update-B.log update-C.log image.log feed.log; do
    [ -f "$W/$f" ] && { echo "--- $f (last 60 lines)"; grep -v 'setup?token=' "$W/$f" | tail -60; }
  done
  usage report
}

step="${1:-}"; shift || true
case "$step" in
  versions)      versions ;;
  prepare)       prepare "$@" ;;
  cut)           cut_release "${1:?cut A|B|C}" ;;
  tree)          make_tree "${1:?tree B|C}" ;;
  install)       install_box ;;
  check-install) check_install ;;
  update-good)   update_good ;;
  update-bad)    update_bad ;;
  usage)         usage "$@" ;;
  logs)          logs ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; [ -z "$step" ] || exit 2 ;;
esac
