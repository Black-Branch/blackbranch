#!/usr/bin/env bash
# Black Branch installer — the first line an operator runs.
#
#   From a checkout or an unpacked release:
#     sudo ./install/install.sh                                   (asks two questions)
#     sudo ./install/install.sh --domain example.com --mode tunnel
#   The published one-liner runs this same script, fetching its release first (section 0 below):
#     curl -fsSL https://blackbranch.app/install.sh | sudo bash
#     curl -fsSL https://blackbranch.app/install.sh | sudo bash -s -- --domain example.com --mode tunnel
#
# Options (each answers a question, so a test can run it unattended):
#   --domain <name>        the site's domain; api.<name> and matrix.<name> are used too. PERMANENT.
#   --mode tunnel|direct   tunnel (default): a Cloudflare tunnel, no open ports
#                          direct: caddy takes ports 80/443 and gets Let's Encrypt certificates
#          internal        LAB ONLY, not for production: caddy's own CA (a test box with no
#                          public DNS); browsers warn until its root certificate is trusted
#   --site-name <text>     the site's display name (default: the domain; `blackbranch set` later)
#   --tunnel-token         tunnel mode with a tunnel made in the Cloudflare dashboard, instead of
#                          the login link: asks for its token (typed, not shown)
#   --tunnel-token-file <file>   the same, the token read from <file> (never on the command line:
#                          there every account on the box can read it, and sudo logs it)
#   --acme-email <addr>    direct mode: Let's Encrypt account email (optional)
#   --skip-dns-check       direct mode: do not require the three names to resolve first
#   --moving               this server takes over a site from its backup (a move, operate.md
#                          "Moving"): installs everything but makes no tunnel and starts nothing —
#                          `blackbranch restore latest --with-env` brings the site, its secrets and
#                          its tunnel back, then starts it. Implies --skip-dns-check.
#   --no-swap              do not add a swap file on a small box
#   --release-key <key>    the key this box trusts to sign its updates ("ed25519:<base64>", or a
#                          file holding it) instead of the project's (install/release-key.pub) —
#                          for a pilot or test feed. Kept until a release signed by it names the
#                          next key (a key rotation, docs/public/operate.md).
#   --update-feed <url>    where this box reads its releases (default https://blackbranch.app/releases;
#                          the one-line form passes the address it came from). Written once, with .env.
#   --update-channel stable|beta   the releases this box follows (default stable; the beta one-line
#                          form passes beta). Written once, with .env: a box already installed keeps
#                          its own (`blackbranch update --channel` changes it).
#
# What it does: installs Docker Engine (Debian/Ubuntu) if missing, copies the release to
# /opt/blackbranch/releases/<version> (a checkout: releases/local; /opt/blackbranch/release points at
# the one in use), writes /opt/blackbranch/.env with a random value for every secret
# (mode 600, never printed), installs the `blackbranch` command and its request watcher, then
# runs `blackbranch up`: Postgres, migrations, images (the site's is pulled by digest — a release
# never builds the site on the box; a checkout does), the router and homeserver config (Synapse +
# MAS, federation off), the homeserver's signing key, every service, and a wait until all are healthy.
#
# Running it again changes nothing: .env is never rewritten, files are replaced only when their
# content differs, and images are fetched or made only when their inputs changed.
# The domain and mode are permanent; a second run that names different ones is refused. On a box
# already installed, only the release it runs is installed again (a repair); another release is
# refused before anything changes — `blackbranch update` moves a box between releases.
set -euo pipefail
umask 022

BB_HOME="${BB_HOME:-/opt/blackbranch}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")/.." && pwd)"
ARGS=("$@")
VERSION_RE='^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})(-[0-9a-z-]+(\.[0-9a-z-]+)*)?$'

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31minstall: %s\033[0m\n' "$*" >&2; exit 1; }
# Compose's version ("2.29.1", "v2.20.0", "5.6.0") is 2.20 or newer.
compose_version_ok() {
  [[ "${1#v}" =~ ^([0-9]+)\.([0-9]+) ]] || return 1
  [ "${BASH_REMATCH[1]}" -gt 2 ] || { [ "${BASH_REMATCH[1]}" = 2 ] && [ "${BASH_REMATCH[2]}" -ge 20 ]; }
}
# The image registry answers this server at all (any HTTP status will do: ghcr.io/v2/ answers 401).
# Not `curl -4`: a NAT64 network reaches it over IPv6 and works; a server with IPv6 alone does not.
ipv4_out_ok() {
  local code; code=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "${BB_REGISTRY_PROBE:-https://ghcr.io/v2/}" 2>/dev/null || true)
  [ -n "$code" ] && [ "$code" != 000 ]
}

DOMAIN="" MODE="" SITE_NAME_ARG="" TUNNEL_TOKEN="" TUNNEL_TOKEN_ASK=0 TUNNEL_TOKEN_FILE="" ACME_EMAIL="" SKIP_DNS=0 NO_SWAP=0 RELEASE_KEY_ARG="" UPDATE_FEED_ARG="" UPDATE_CHANNEL_ARG="" MOVING=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --mode) MODE="${2:?}"; shift 2 ;;
    --site-name) SITE_NAME_ARG="${2:?}"; shift 2 ;;
    --tunnel-token)
      if [ $# -gt 1 ] && [[ "$2" != -* ]]; then
        die "--tunnel-token takes no value: a token on the command line is visible to every account on the box (ps) and kept in sudo's log. Run with --tunnel-token alone to type it, or --tunnel-token-file <file>"
      fi
      TUNNEL_TOKEN_ASK=1; shift ;;
    --tunnel-token-file) TUNNEL_TOKEN_FILE="${2:?}"; shift 2 ;;
    --acme-email) ACME_EMAIL="${2:?}"; shift 2 ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    --moving) MOVING=1; SKIP_DNS=1; shift ;;
    --no-swap) NO_SWAP=1; shift ;;
    --release-key) RELEASE_KEY_ARG="${2:?}"; shift 2 ;;
    --update-feed) UPDATE_FEED_ARG="${2:?}"; shift 2 ;;
    --update-channel) UPDATE_CHANNEL_ARG="${2:?}"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]:-/dev/null}"; exit 0 ;;
    *) die "unknown option $1 (--help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root: sudo $0 $*"
if [ -n "$UPDATE_FEED_ARG" ] && ! [[ "$UPDATE_FEED_ARG" =~ ^https?://[A-Za-z0-9._~:/%-]+$ ]]; then die "--update-feed must be an http(s) address"; fi
case "$UPDATE_CHANNEL_ARG" in ""|stable|beta) ;; *) die "--update-channel must be stable or beta" ;; esac

# ── An install already here ─────────────────────────────────────────────────────────────────
# An installed box moves to another release only through `blackbranch update`: it holds the update
# lock, backs up first, tries the new release beside the running one, checks its health and goes
# back when it fails. This installer re-runs only the release the box already runs (a repair: the
# same files put back, .env kept) and refuses any other — and another release key — before it
# fetches, installs or changes anything.
ENV_FILE="$BB_HOME/.env"
env_get() { local l; l=$(grep -m1 -E "^$1=" "$ENV_FILE" 2>/dev/null || true); l="${l#*=}"; l="${l#\"}"; printf '%s' "${l%\"}"; }
ver_lt() { # ver_lt A B — is release A older than release B? (core by number; a pre-release first)
  local a="${1%%-*}" b="${2%%-*}"
  if [ "$a" != "$b" ]; then [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -1)" = "$a" ]; return; fi
  [ "$1" != "$2" ] && [ "$1" != "$a" ] && { [ "$2" = "$b" ] || [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }
}
installed_release() { # the release this box runs ("local": a checkout's), or nothing
  local l
  if [ -L "$BB_HOME/release" ]; then l=$(readlink "$BB_HOME/release"); printf '%s' "${l#releases/}"
  elif [ -d "$BB_HOME/release" ]; then printf local; fi   # an install from before the update channel
}
guard_existing() { # guard_existing <this installer's release>
  local cur want have
  cur=$(installed_release)
  if [ -n "$cur" ] && [ "$cur" != "$1" ]; then
    if [ "$1" != local ] && [ "$cur" != local ] && ver_lt "$1" "$cur"; then
      die "this box runs release $cur, newer than this installer's $1 — never install an older release over a newer one (blackbranch update) — nothing was changed"
    fi
    die "this box runs release $cur; this installer is $1. An installed box changes release only through its updater, which backs up first, tries the new release beside the running one and goes back when its health check fails: sudo blackbranch update (or the Admin Panel's Updates). Running the installer of $cur again repairs this box — nothing was changed"
  fi
  have=$(env_get BB_RELEASE_KEY); want="$RELEASE_KEY_ARG"
  if [ -n "$want" ] && [ -f "$want" ]; then want=$(head -1 "$want"); fi
  if [ -n "$have" ] && [ -n "$want" ] && [ "$have" != "$want" ]; then
    die "this box already trusts another release key; a box keeps the key it was installed with — nothing was changed"
  fi
}

# ── 0. The one-line form ────────────────────────────────────────────────────────────────────
# `curl -fsSL <project site>/install.sh | sudo bash` runs this file with nothing beside it. The copy
# the project publishes is stamped by `tools/release.mjs cut` with ONE release: its version, the
# size and sha256 of its source, the address it lies at (the release feed's) and the channel it was
# cut for (install-beta.sh: beta, which a new box then follows). This fetches it,
# checks it against the stamp, unpacks it as $BB_HOME/releases/<version> — where an update puts a
# release — and runs the installer inside it with the same options, reading its questions from the
# terminal (stdin is this script). The repo's own copy is unstamped and says how to run it instead.
# A function, called on one line: a download cut short can never run half of it.
BOOTSTRAP_VERSION=""
BOOTSTRAP_SHA256=""
BOOTSTRAP_SIZE=""
BOOTSTRAP_BASE=""
BOOTSTRAP_CHANNEL=""
bootstrap() {
  [ -n "$BOOTSTRAP_VERSION" ] || die "run this from a release or checkout: $SRC has no install/compose.yaml (git clone the repository and run sudo ./install/install.sh, or use the one-line form the project site publishes)"
  if ! [[ "$BOOTSTRAP_VERSION" =~ $VERSION_RE ]] || ! [[ "$BOOTSTRAP_SHA256" =~ ^[0-9a-f]{64}$ ]] || ! [[ "$BOOTSTRAP_SIZE" =~ ^[0-9]{1,10}$ ]] \
     || ! [[ "$BOOTSTRAP_BASE" =~ ^https?://[A-Za-z0-9._~:/%-]+$ ]] || ! [[ "$BOOTSTRAP_CHANNEL" =~ ^(|stable|beta)$ ]]; then
    die "this copy of install.sh is damaged: its release stamp does not read"
  fi
  guard_existing "$BOOTSTRAP_VERSION"
  local dest="$BB_HOME/releases/$BOOTSTRAP_VERSION" part tgz url bad tty=/dev/null
  part="$dest.partial"; tgz="$BB_HOME/releases/.blackbranch-$BOOTSTRAP_VERSION.tar.gz"
  url="${BOOTSTRAP_BASE%/}/blackbranch-$BOOTSTRAP_VERSION.tar.gz"
  if [ "$(head -1 "$dest/RELEASE" 2>/dev/null)" != "$BOOTSTRAP_VERSION" ] || [ ! -f "$dest/install/install.sh" ]; then
    say "Fetching release $BOOTSTRAP_VERSION"
    command -v curl >/dev/null || die "curl is needed"
    mkdir -p "$BB_HOME/releases"; chown root:root "$BB_HOME"; chmod 750 "$BB_HOME"; chmod 755 "$BB_HOME/releases"
    rm -rf "$part" "$tgz"
    if ! curl -fsSL --proto '=https,http' --proto-redir '=https' --max-redirs 3 --connect-timeout 20 --max-time 900 \
         --max-filesize "$BOOTSTRAP_SIZE" -o "$tgz" "$url"; then
      rm -f "$tgz"; die "could not fetch $url — nothing was installed"
    fi
    if [ "$(stat -c %s "$tgz")" != "$BOOTSTRAP_SIZE" ] || [ "$(sha256sum "$tgz" | cut -d' ' -f1)" != "$BOOTSTRAP_SHA256" ]; then
      rm -f "$tgz"; die "the release fetched from $url is not the one this installer names (size or sha256) — nothing was installed"
    fi
    # The update's own rules (blackbranch update_fetch_source): plain files and folders only, all
    # under the one top folder, no "..", nothing set-user or set-group, RELEASE naming the version.
    bad=$(tar -tvzf "$tgz" | awk '{ t = substr($1, 1, 1); if (t != "-" && t != "d") { print; exit } }')
    [ -n "$bad" ] || bad=$(tar -tzf "$tgz" | grep -vE "^blackbranch-$BOOTSTRAP_VERSION(/|\$)" | head -1 || true)
    [ -n "$bad" ] || bad=$(tar -tzf "$tgz" | grep -E '(^|/)\.\.(/|$)' | head -1 || true)
    if [ -n "$bad" ]; then rm -f "$tgz"; die "the release holds an entry a release may not hold — nothing was installed"; fi
    mkdir -p "$part"
    tar -xzf "$tgz" -C "$part" --strip-components=1 --no-same-owner --no-same-permissions
    if [ -n "$(find "$part" -perm /6000 -print -quit)" ]; then rm -rf "$part" "$tgz"; die "the release holds a set-user or set-group file — nothing was installed"; fi
    if [ "$(head -1 "$part/RELEASE" 2>/dev/null)" != "$BOOTSTRAP_VERSION" ] || [ ! -f "$part/install/install.sh" ]; then
      rm -rf "$part" "$tgz"; die "the release does not name itself $BOOTSTRAP_VERSION — nothing was installed"
    fi
    rm -rf "$dest"; mv "$part" "$dest"; rm -f "$tgz"
    info "checked (sha256 ${BOOTSTRAP_SHA256:0:16}…, $BOOTSTRAP_SIZE bytes) and unpacked as $dest"
  fi
  if ( : < /dev/tty ) 2>/dev/null; then tty=/dev/tty; fi
  # The feed it came from, and its channel (install-beta.sh: beta); an option the operator gave wins.
  local first=(--update-feed "$BOOTSTRAP_BASE")
  if [ -n "$BOOTSTRAP_CHANNEL" ]; then first+=(--update-channel "$BOOTSTRAP_CHANNEL"); fi
  if [ -n "${BB_BOOTSTRAP_NO_EXEC:-}" ]; then echo "would run $dest/install/install.sh ${first[*]} ${ARGS[*]}"; exit 0; fi   # test hook
  exec bash "$dest/install/install.sh" "${first[@]}" "${ARGS[@]}" < "$tty"
}
# Piped (no file of its own), it is always the one-line form: never whatever folder it was run from.
if [ -z "${BASH_SOURCE[0]:-}" ] || [ ! -f "$SRC/install/compose.yaml" ] || [ ! -d "$SRC/migrations/baseline" ]; then bootstrap; fi

# Each release lives in its own folder, so an update can go back to the one before it. A published
# release names itself (its RELEASE file holds the version); a checkout is "local".
rel_id=local
if [ -f "$SRC/RELEASE" ] && [[ "$(head -1 "$SRC/RELEASE")" =~ $VERSION_RE ]]; then rel_id=$(head -1 "$SRC/RELEASE"); fi
# The updater's own lock (blackbranch update_apply: state/update.lock), taken before the check below
# and held until the services are up. Without it a repair could pass its check, an update (the
# nightly timer's, too) could migrate the database and move the pointer to its release, and the
# repair would then point the box back at the older code over the newer schema. Held, not just
# re-checked before the switch: the installer's own `blackbranch up` applies migrations too, and two
# of those must never run at once. An update already running is said and the installer stops — an
# update can take many minutes, and a silent wait reads as a hang.
mkdir -p "$BB_HOME/state"
exec 9>"$BB_HOME/state/update.lock"
if ! flock -n 9; then
  info "blackbranch update is running; waiting up to ${BB_INSTALL_LOCK_WAIT:-60} s for it to finish"
  flock -w "${BB_INSTALL_LOCK_WAIT:-60}" 9 || die "blackbranch update is running (it holds $BB_HOME/state/update.lock); run this again once it has finished — blackbranch status shows its progress — nothing was changed"
fi
guard_existing "$rel_id"
# What the check above saw, compared again under the lock just before the pointer moves (section 3).
installed_at_check=$(installed_release)
if [ "${BB_INSTALL_TEST_STOP:-}" = preflight ]; then echo "install: preflight passed ($rel_id)"; exit 0; fi   # test hook

# ── 1. The box ──────────────────────────────────────────────────────────────────────────────
# (BB_INSTALL_TEST_STOP=env, a test hook, leaves the host alone: this whole section is skipped, and
# the installer stops once .env is written. The section is not indented: it holds a heredoc.)
if [ "${BB_INSTALL_TEST_STOP:-}" != env ] && [ "${BB_INSTALL_TEST_STOP:-}" != front-door ]; then
say "Checking the box"
# shellcheck source=/dev/null # the OS file differs per box; nothing in it is checked
. /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) die "supported: Debian stable and Ubuntu LTS (this is ${PRETTY_NAME:-unknown})" ;; esac
[ "$(uname -m)" = x86_64 ] || die "supported: x86-64 (this is $(uname -m))"
# MiB (kB / 1024). The doctor's box.memory check uses the same floor (config/doctor.mjs MIN_MEMORY_MIB;
# install/doctor.test.mjs holds the two equal): an installer that accepts a box the doctor then fails is
# a box set up to fail. A "4 GB" server reports a little under 4096.
MIN_MEMORY_MIB=3600
mem_mb=$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)
info "${PRETTY_NAME}, ${mem_mb} MiB memory, $(df -h / | awk 'NR==2{print $4}') free disk"
[ "$mem_mb" -ge "$MIN_MEMORY_MIB" ] || die "at least 4 GB of memory is needed (found ${mem_mb} MiB; the floor is $MIN_MEMORY_MIB MiB)"

apt_install() { # apt_install <pkg>... — only the missing ones
  local missing=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [ "${#missing[@]}" -eq 0 ] && return 0
  info "installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
}
apt_install ca-certificates curl rsync openssl unattended-upgrades
# The images come from registries that answer over IPv4 only (ghcr.io has no IPv6 address): an
# IPv6-only server was accepted and then failed at its first download (R1.7).
ipv4_out_ok || die "this server cannot reach the image registry (https://ghcr.io): the bundle's images come from registries that answer over IPv4 only, so a server with IPv6 alone cannot fetch them. Give it an IPv4 address or route out (or a NAT64/DNS64 network), check its DNS, then run this again — nothing was installed"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker Engine (Docker's own apt repository)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${VERSION_CODENAME:?}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker >/dev/null
fi
info "$(docker --version); $(docker compose version | head -1)"
# Compose 2.20 brought `docker compose wait`, which `up` uses to wait for the migrations: an older
# one failed there and read as "the database migrations failed" (R1.7).
compose_v=$(docker compose version --short 2>/dev/null || true)
compose_version_ok "$compose_v" \
  || die "Docker Compose ${compose_v:-of unknown version} is too old: Black Branch needs 2.20 or newer. Update it (Docker's apt repository: apt-get install docker-compose-plugin), then run this again — nothing was installed"

# The host patches itself. Turned on once; a choice the operator changes later is kept.
if [ ! -f /etc/apt/apt.conf.d/20auto-upgrades ]; then
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  info "unattended upgrades on"
fi

# Building the site peaks near a 4 GB box's whole memory. A
# release never builds it — its image is pulled — so only a checkout, which builds the
# site's image here, gets a swap file on a small box: the build is then slow rather than killed.
web_built_here() { awk '/^  web:[[:space:]]*$/ { w = 1; next } w && /^  [^ #]/ { exit } w && /^    build:/ { f = 1 } END { exit !f }' "$SRC/install/compose.yaml"; }
if [ "$NO_SWAP" = 0 ] && [ "$mem_mb" -lt 7500 ] && [ "$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)" = 0 ] && web_built_here; then
  if [ ! -f /swapfile.blackbranch ]; then
    info "adding a 2 GB swap file (/swapfile.blackbranch)"
    fallocate -l 2G /swapfile.blackbranch && chmod 600 /swapfile.blackbranch && mkswap -q /swapfile.blackbranch
    grep -q '^/swapfile.blackbranch ' /etc/fstab || echo '/swapfile.blackbranch none swap sw 0 0' >> /etc/fstab
  fi
  swapon /swapfile.blackbranch 2>/dev/null || true
fi
fi   # section 1

# ── 2. The two questions ────────────────────────────────────────────────────────────────────
ask() { # ask <var> <prompt>
  [ -r /dev/tty ] || die "$2 — not given, and there is no terminal to ask on (use the flags, --help)"
  local a; read -r -p "   $2: " a < /dev/tty; printf -v "$1" '%s' "$a"
}
# A dashboard tunnel's token: from a file, or typed — never an argument (every account can read
# those, and sudo logs them). It goes into .env unquoted, so only a token's own characters pass.
read_tunnel_token() {
  if [ -n "$TUNNEL_TOKEN_FILE" ]; then
    [ -r "$TUNNEL_TOKEN_FILE" ] || die "cannot read --tunnel-token-file $TUNNEL_TOKEN_FILE"
    TUNNEL_TOKEN=$(head -1 "$TUNNEL_TOKEN_FILE" | tr -d '\r')
  elif [ "$TUNNEL_TOKEN_ASK" = 1 ]; then
    [ -r /dev/tty ] || die "--tunnel-token: there is no terminal to type it on (use --tunnel-token-file <file>)"
    read -rs -p "   The tunnel's token, from the Cloudflare dashboard (not shown): " TUNNEL_TOKEN < /dev/tty; echo >&2
  fi
  if [ -n "$TUNNEL_TOKEN_FILE$TUNNEL_TOKEN" ] && ! [[ "$TUNNEL_TOKEN" =~ ^[A-Za-z0-9+/=_-]{32,4096}$ ]]; then
    die "that is not a Cloudflare tunnel token (letters, digits and + / = _ - only) — nothing was written"
  fi
}
if [ -f "$ENV_FILE" ]; then
  have_domain=$(env_get BB_DOMAIN); have_mode=$(env_get BB_TLS_MODE)
  [ -z "$DOMAIN" ] || [ "$DOMAIN" = "$have_domain" ] || die "this box is installed for $have_domain; the domain cannot change"
  [ -z "$MODE" ] || [ "$MODE" = "$have_mode" ] || die "this box is installed in $have_mode mode; changing the mode is not supported yet"
  DOMAIN="$have_domain"; MODE="$have_mode"
  say "Existing install: $DOMAIN ($MODE) — .env kept as it is"
  have_channel=$(env_get BB_UPDATE_CHANNEL); have_channel="${have_channel:-stable}"
  if [ -n "$UPDATE_CHANNEL_ARG" ] && [ "$UPDATE_CHANNEL_ARG" != "$have_channel" ]; then
    info "this box follows the $have_channel channel, and keeps it (blackbranch update --channel $UPDATE_CHANNEL_ARG changes it)"
  fi
  # A token given again (the first was wrong, or the tunnel was remade in the dashboard) replaces the
  # old one — the only change a re-run makes to .env. `up` below recreates cloudflared with it.
  if [ -n "$TUNNEL_TOKEN_FILE" ] || [ "$TUNNEL_TOKEN_ASK" = 1 ]; then
    [ "$MODE" = tunnel ] || die "this box is installed in $MODE mode: it has no tunnel, so a tunnel token means nothing here — nothing was changed"
    read_tunnel_token
    if [ "$TUNNEL_TOKEN" = "$(env_get CLOUDFLARE_TUNNEL_TOKEN)" ]; then info "tunnel token unchanged"
    else
      signed_in=""; [ -n "$(env_get CLOUDFLARE_TUNNEL_TOKEN)" ] || signed_in=1
      tmp=$(mktemp "$BB_HOME/.env.XXXXXX"); chmod 600 "$tmp"
      TOKEN="$TUNNEL_TOKEN" awk '/^CLOUDFLARE_TUNNEL_TOKEN=/ { print "CLOUDFLARE_TUNNEL_TOKEN=" ENVIRON["TOKEN"]; next } { print }' "$ENV_FILE" > "$tmp" \
        || { rm -f "$tmp"; die "could not write the new token (is the disk full?) — nothing was changed"; }
      mv -f "$tmp" "$ENV_FILE"
      info "tunnel token replaced in $ENV_FILE (cloudflared starts with it below)"
      # A tunnel made by signing in, given a dashboard tunnel's token (R1.6: its tunnel was deleted —
      # a move's dead end — or the operator prefers the dashboard): the token tunnel takes over. The
      # signed-in tunnel's config is set aside, so the front door below writes the token's.
      if [ -n "$signed_in" ] && [ -f "$BB_HOME/cloudflared/config.yml" ]; then
        mv -f "$BB_HOME/cloudflared/config.yml" "$BB_HOME/cloudflared/config.yml.signed-in-$(date -u +%Y%m%d-%H%M%S)"
        info "the tunnel made by signing in is replaced by the dashboard tunnel whose token you gave"
      fi
    fi
  fi
else
  say "Two questions"
  [ -n "$DOMAIN" ] || ask DOMAIN "Your site's domain (example.com — api. and matrix. are used too)"
  [ -n "$MODE" ] || { ask MODE "Front door: tunnel (Cloudflare, no open ports) or direct (ports 80/443) [tunnel]"; MODE="${MODE:-tunnel}"; }
  read_tunnel_token
fi
DOMAIN="${DOMAIN,,}"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] || die "\"$DOMAIN\" is not a domain name"
case "$MODE" in tunnel|direct|internal) ;; *) die "mode must be tunnel or direct (or internal for a lab box)" ;; esac
[ "$MODE" = internal ] && info "⚠ internal TLS: LAB MODE, not for production — certificates from caddy's own CA"

# ── 3. The release ──────────────────────────────────────────────────────────────────────
# ($rel_id was read, and checked against an install already here, before section 1.)
say "Copying the release ($rel_id) to $BB_HOME/releases/$rel_id"
# The install's home is root's and its group's alone (750): a host account that shares a service's uid
# (65532 owns cloudflared/, 1000 the site's drop box and recovery sheet) cannot walk into it. Its group
# is root's too: a home that existed before (made by hand, or by another tool) could carry a group
# with members, and 750 would let them in.
mkdir -p "$BB_HOME/releases"; chown root:root "$BB_HOME"; chmod 750 "$BB_HOME"; chmod 755 "$BB_HOME/releases"
# An install made before the update channel kept its release in a plain folder.
if [ -d "$BB_HOME/release" ] && [ ! -L "$BB_HOME/release" ]; then
  [ ! -e "$BB_HOME/releases/local" ] || die "$BB_HOME/release and $BB_HOME/releases/local both exist — move one away first"
  mv "$BB_HOME/release" "$BB_HOME/releases/local"; ln -s releases/local "$BB_HOME/release"
  info "the installed release moved to releases/local"
fi
dest="$BB_HOME/releases/$rel_id"
if [ "$(cd "$SRC" && pwd -P)" != "$( { [ -d "$dest" ] && cd "$dest" && pwd -P; } || true)" ]; then
  # Its own command, not an argument: inside `info "$(…)"` its refusal (a private file in the copy)
  # was swallowed, set -e never saw it, and the half-made copy became the release. The copy is made
  # beside $dest and swapped in only once it passed, so a refusal leaves nothing to clean: no folder
  # where there was none, and a release already here (perhaps the one in use) as it was.
  if ! copied=$(bash "$SRC/install/release-copy.sh" "$SRC" "$dest"); then
    die "the release copy was refused (above) — no release was selected$([ ! -d "$dest" ] || printf '%s' "; $dest is as it was")"
  fi
  info "$copied"
  if [ "$rel_id" = local ]; then
    rev="unknown source"
    if git -C "$SRC" rev-parse HEAD >/dev/null 2>&1; then
      rev="git $(git -C "$SRC" rev-parse --short=12 HEAD)$(git -C "$SRC" diff --quiet HEAD -- 2>/dev/null || echo ' (uncommitted changes)')"
    fi
    printf '%s\n' "$rev" > "$dest/RELEASE.new"
    if cmp -s "$dest/RELEASE.new" "$dest/RELEASE"; then rm -f "$dest/RELEASE.new"; else mv -f "$dest/RELEASE.new" "$dest/RELEASE"; fi
  fi
else
  info "running from the installed release; nothing to copy"
fi
# Test hook: pause here until a line arrives on this FIFO (a test moves the pointer meanwhile).
if [ -n "${BB_INSTALL_TEST_HOLD:-}" ]; then
  exec 8<>"$BB_INSTALL_TEST_HOLD"; read -r -t 30 -u 8 _ || die "test hold: nothing arrived"; exec 8<&-
fi
# The lock keeps out every updater that takes it; this catches a pointer moved by anything that
# does not (a `blackbranch` from before the lock, a hand edit): never switch a box back.
now_installed=$(installed_release)
if [ "$now_installed" != "$installed_at_check" ]; then
  die "the release this box runs changed while this installer ran (${installed_at_check:-none} → $now_installed); the box is left on $now_installed. Running the installer of $now_installed repairs it"
fi
if [ "$(readlink "$BB_HOME/release" 2>/dev/null || true)" != "releases/$rel_id" ]; then
  ln -sfn "releases/$rel_id" "$BB_HOME/release.new" && mv -Tf "$BB_HOME/release.new" "$BB_HOME/release"
fi
info "release: $(head -1 "$BB_HOME/release/RELEASE")"

# The key this box trusts to sign its updates: the project's, or --release-key's.
KEY_RE='^ed25519:[A-Za-z0-9+/]{43}=$'
release_key="$RELEASE_KEY_ARG"
if [ -n "$release_key" ] && [ -f "$release_key" ]; then release_key=$(head -1 "$release_key"); fi
[ -n "$release_key" ] || release_key=$(head -1 "$BB_HOME/release/install/release-key.pub" 2>/dev/null || true)
[[ "$release_key" =~ $KEY_RE ]] || die "the release key is not an ed25519 key (ed25519:<base64>)"
# A new .env starts at the newest .env migration (install/migrations/).
env_version=0
for f in "$BB_HOME/release/install/migrations"/[0-9][0-9][0-9]-*.sh; do
  [ -e "$f" ] || continue; n=$(basename "$f"); n=$((10#${n:0:3})); [ "$n" -gt "$env_version" ] && env_version=$n
done

# ── 4. .env: written once ───────────────────────────────────────────────────────────────────
# Every secret is made BEFORE .env is written, and checked: made inside the heredoc below, a
# generator that failed wrote an empty secret into .env and the install carried on with it.
secret() { # secret <KEY> <bytes> → SECRET_<KEY>, random hex; the installer stops when it cannot be made
  local v
  v=$(openssl rand -hex "$2" 2>/dev/null) || v=""
  if ! [[ "$v" =~ ^[0-9a-f]+$ ]] || [ "${#v}" -ne $(( $2 * 2 )) ]; then die "could not generate $1 (openssl rand failed) — nothing was written"; fi
  printf -v "SECRET_$1" '%s' "$v"
}
ulid() { # MAS client ids are ULIDs: 48-bit time + 80 random bits, Crockford base32
  local A=0123456789ABCDEFGHJKMNPQRSTVWXYZ t s="" b
  t=$(date +%s%3N)
  for _ in 1 2 3 4 5 6 7 8 9 10; do s="${A:$((t % 32)):1}$s"; t=$((t / 32)); done
  for b in $(od -An -tu1 -N16 /dev/urandom); do s+="${A:$((b % 32)):1}"; done
  printf '%s' "$s"
}
q() { local v="${1//\\/\\\\}"; printf '"%s"' "${v//\"/\\\"}"; }
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE (every secret random, mode 600, never printed)"
  site_name="${SITE_NAME_ARG:-$DOMAIN}"
  case "$site_name" in *'$'*|*$'\n'*) die "--site-name may not contain \$ or a line break" ;; esac
  case "$MODE" in tunnel) profiles=tunnel; files="$BB_HOME/compose.yaml" ;;
                  internal) profiles=""; files="$BB_HOME/compose.yaml:$BB_HOME/compose.public.yaml:$BB_HOME/compose.lab.yaml" ;;
                  *) profiles=""; files="$BB_HOME/compose.yaml:$BB_HOME/compose.public.yaml" ;; esac
  secret POSTGRES_PASSWORD 24
  secret STREAM_DB_PASSWORD 24
  secret SYNAPSE_DB_PASSWORD 24
  secret MAS_DB_PASSWORD 24
  secret STREAM_API_SECRET 32
  secret AUTH_SECRET 32
  secret TOKEN_ENC_KEY 32
  secret INSTANCE_MASTER_KEY 32
  secret MATRIX_OAUTH_CLIENT_SECRET 32
  secret MAS_SYNAPSE_SECRET 32
  secret MAS_ENCRYPTION_SECRET 32
  secret SYNAPSE_REGISTRATION_SECRET 32
  secret SYNAPSE_MACAROON_SECRET 32
  secret SYNAPSE_FORM_SECRET 32
  secret BACKUP_PASSPHRASE 24
  client_id=$(ulid)
  [[ "$client_id" =~ ^[0-9A-Z]{26}$ ]] || die "could not generate the sign-in client's id — nothing was written"
  tmp=$(mktemp "$BB_HOME/.env.XXXXXX"); chmod 600 "$tmp"
  cat > "$tmp" <<EOF
# Black Branch install — the ONE place this install's values and bootstrap secrets live.
# Written once by install.sh. Display values change with \`blackbranch set\`; the identity block
# never changes (the Matrix server name and the origins are permanent). Back this file up: the
# secrets below cannot be recovered from anywhere else.

# ── Bundle ──
COMPOSE_PROJECT_NAME=blackbranch
COMPOSE_FILE=$files
COMPOSE_PROFILES=$profiles
BB_HOME=$BB_HOME
BB_DOMAIN=$DOMAIN
BB_TLS_MODE=$MODE
BB_ACME_EMAIL=$ACME_EMAIL
CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN
# The bundle network, cloudflared's fixed address in it (the only proxy caddy trusts), and caddy's
# (the only proxy stream-api believes about a viewer's address). Change all three together.
BB_SUBNET=172.29.83.0/24
BB_CLOUDFLARED_IP=172.29.83.250
BB_CADDY_IP=172.29.83.249

# ── Updates: the key below is the one this box trusts; an update never changes it ────────────
BB_RELEASE=$rel_id
BB_RELEASE_KEY=$release_key
BB_UPDATE_FEED=${UPDATE_FEED_ARG:-https://blackbranch.app/releases}
BB_UPDATE_CHANNEL=${UPDATE_CHANNEL_ARG:-stable}
BB_ENV_VERSION=$env_version

# ── Identity (permanent) ──
SITE_ORIGIN=https://$DOMAIN
SITE_API_ORIGIN=https://api.$DOMAIN
SITE_API_WS_ORIGIN=wss://api.$DOMAIN
MATRIX_SERVER_NAME=$DOMAIN
MATRIX_HOMESERVER_URL=https://matrix.$DOMAIN
MATRIX_OAUTH_ISSUER=https://matrix.$DOMAIN/auth/
MATRIX_OAUTH_CLIENT_ID=$client_id

# ── Display values (read by the site when it starts; \`blackbranch set <KEY> <value>\`) ──
SITE_NAME=$(q "$site_name")
SITE_SHORT_NAME=
SITE_TAGLINE=
SITE_DESCRIPTION=
SITE_HOME_HEADING=
SITE_HOME_INTRO=
SITE_ICON_SET=
LEGAL_OPERATOR=
LEGAL_CONTACT_EMAIL=
LEGAL_GOVERNING_LAW=
LEGAL_EFFECTIVE_DATE=
CURRENCY_NAME=
CURRENCY_NAME_PLURAL=
CURRENCY_SYMBOL=
CURRENCY_ICON=
COMMUNITY_SCORE_NAME=
YOUTUBE_VOD_PLAYLIST=none

# ── Secrets (random; never printed) ──
POSTGRES_PASSWORD=$SECRET_POSTGRES_PASSWORD
STREAM_DB_PASSWORD=$SECRET_STREAM_DB_PASSWORD
SYNAPSE_DB_PASSWORD=$SECRET_SYNAPSE_DB_PASSWORD
MAS_DB_PASSWORD=$SECRET_MAS_DB_PASSWORD
STREAM_API_SECRET=$SECRET_STREAM_API_SECRET
AUTH_SECRET=$SECRET_AUTH_SECRET
TOKEN_ENC_KEY=$SECRET_TOKEN_ENC_KEY
INSTANCE_MASTER_KEY=$SECRET_INSTANCE_MASTER_KEY
MATRIX_OAUTH_CLIENT_SECRET=$SECRET_MATRIX_OAUTH_CLIENT_SECRET
MAS_SYNAPSE_SECRET=$SECRET_MAS_SYNAPSE_SECRET
MAS_ENCRYPTION_SECRET=$SECRET_MAS_ENCRYPTION_SECRET
SYNAPSE_REGISTRATION_SECRET=$SECRET_SYNAPSE_REGISTRATION_SECRET
SYNAPSE_MACAROON_SECRET=$SECRET_SYNAPSE_MACAROON_SECRET
SYNAPSE_FORM_SECRET=$SECRET_SYNAPSE_FORM_SECRET
BACKUP_PASSPHRASE=$SECRET_BACKUP_PASSPHRASE

# ── First boot ──
# sha256 of the setup link's token (\`blackbranch setup-link\`); written by \`blackbranch up\`.
SETUP_TOKEN_HASH=
EOF
  # This install's recovery sheet is still to be shown (blackbranch: RECOVERY_DUE) — root's own
  # record, written only with a NEW .env: an install from before the sheet never gets one.
  if ! { mkdir -p "$BB_HOME/state" && touch "$BB_HOME/state/recovery-sheet-due"; }; then
    rm -f "$tmp"; die "could not write $BB_HOME/state (is the disk full?) — nothing was written"
  fi
  mv -f "$tmp" "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
# An .env from before the update channel: it learns the key now (an existing key is never replaced).
# (Another key on the command line was refused before anything changed: guard_existing.)
if [ -z "$(env_get BB_RELEASE_KEY)" ]; then
  printf 'BB_RELEASE_KEY=%s\n' "$release_key" >> "$ENV_FILE"; info "release key recorded in .env"
fi

# Files here belong to the uids the services run as: Synapse's (991) and MAS's (65532) config inside
# rendered/, the tunnel's credentials (cloudflared/, 65532), the site's drop box (requests/) and its
# recovery sheet (1000 — the image's `node`, and on most hosts the first person's account). $BB_HOME
# is root's (750), so a host account that already has one of those uids cannot walk in. Said, so the
# operator knows that account is a service's twin.
for uid in "991:Synapse:its config under $BB_HOME/rendered/" "65532:MAS (and the tunnel):MAS's config and the tunnel's credentials" \
           "1000:the site:the site's drop box ($BB_HOME/requests/) and its recovery sheet"; do
  IFS=: read -r n who what <<< "$uid"
  acct=$(getent passwd "$n" 2>/dev/null | cut -d: -f1 || true)
  [ -z "$acct" ] || info "⚠ the host account $acct has uid $n, the one $who runs as: it owns $what ($BB_HOME is root's, so it cannot reach them — but do not give that account other secrets)"
done

if [ "${BB_INSTALL_TEST_STOP:-}" = env ]; then echo "install: .env written ($rel_id)"; exit 0; fi   # test hook

# The front door (section 6), a function so a test can run it alone (BB_INSTALL_TEST_STOP=front-door).
front_door() {
  local cfdir="$BB_HOME/cloudflared" image name="blackbranch-$DOMAIN" out uuid h
  if [ "$MODE" = tunnel ]; then
    say "Cloudflare tunnel"
    image=$(grep -m1 -oE 'cloudflare/cloudflared:[^ ]+' "$BB_HOME/release/install/compose.yaml") || die "the release names no cloudflared image"
    mkdir -p "$cfdir"; chown 65532:65532 "$cfdir"; chmod 700 "$cfdir"   # cloudflared's image runs as uid 65532
    if [ -n "$(env_get CLOUDFLARE_TUNNEL_TOKEN)" ]; then
      [ -f "$cfdir/config.yml" ] || printf '# Token tunnel: its routes are set in the Cloudflare dashboard.\nno-autoupdate: true\n' > "$cfdir/config.yml"
      info "token tunnel: in the Cloudflare dashboard, route $DOMAIN, api.$DOMAIN and matrix.$DOMAIN to http://caddy:80"
    elif [ "$MOVING" = 1 ] && [ ! -f "$cfdir/config.yml" ]; then
      # A move: the site's own tunnel comes back with the restore, and connects from here.
      info "moving: no tunnel is made here — the restore brings back the site's own tunnel"
    elif [ ! -f "$cfdir/config.yml" ]; then
      cf() { docker run --rm -v "$cfdir:/home/nonroot/.cloudflared" "$image" "$@"; }
      if [ ! -f "$cfdir/cert.pem" ]; then
        info "Open the link printed below, sign in to Cloudflare and pick $DOMAIN:"
        docker run --rm -it -v "$cfdir:/home/nonroot/.cloudflared" "$image" tunnel login
        [ -f "$cfdir/cert.pem" ] || die "the Cloudflare sign-in did not finish — run this again"
      fi
      # A tunnel an earlier run made, cut off before config.yml (or stopped by a failed route), is
      # used again: creating it a second time fails on its name, and that run would stop for good.
      out=$(cf tunnel list --name "$name" --output json 2>&1) || die "could not read the account's tunnels: $(printf '%s' "$out" | tail -n 1)"
      uuid=$(printf '%s' "$out" | grep -oE '"id": *"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"' | head -1 | grep -oE '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}' || true)
      if [ -n "$uuid" ]; then
        [ -f "$cfdir/$uuid.json" ] || die "the tunnel $name exists in Cloudflare, but its credentials are not on this server. Moving the site here from another server? Run this again with --moving: the restore brings the tunnel back (docs: operate.md, \"Moving to a bigger server\"). A tunnel left from an install you gave up on: delete it in the dashboard (Zero Trust → Networks → Tunnels) and run this again"
        info "using the tunnel an earlier run made ($name)"
      else
        out=$(cf tunnel create "$name" 2>&1) || die "could not create the tunnel $name: $(printf '%s' "$out" | tail -n 1)"
        uuid=$(printf '%s' "$out" | grep -oE '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}' | head -1 || true)
        [ -n "$uuid" ] || die "could not create the tunnel: $out"
      fi
      # Every route, or the installer stops: a name with no route is a site nobody reaches, and a
      # run that carried on wrote config.yml — after which a re-run said "already configured" and
      # never tried the route again. (The usual cause: a record the name already has.)
      for h in "$DOMAIN" "api.$DOMAIN" "matrix.$DOMAIN"; do
        if ! out=$(cf tunnel route dns "$uuid" "$h" 2>&1); then
          die "routing $h to the tunnel failed: $(printf '%s' "$out" | tail -n 1). If $h already has a DNS record (an A or CNAME — often the bare domain's), remove it in Cloudflare's dashboard, then run this again: the tunnel is kept, and nothing is made twice"
        fi
        info "routed $h"
      done
      # config.yml last: its being there is what "configured" means to a re-run.
      printf 'tunnel: %s\ncredentials-file: /etc/cloudflared/%s.json\nno-autoupdate: true\ningress:\n  - service: http://caddy:80\n' "$uuid" "$uuid" > "$cfdir/config.yml.new"
      mv -f "$cfdir/config.yml.new" "$cfdir/config.yml"
      chown 65532:65532 "$cfdir"/*
    else
      info "tunnel already configured"
    fi
    # The sign-in certificate `tunnel login` left is the Cloudflare ACCOUNT's (it makes and routes
    # tunnels for every zone it was given); the running tunnel needs only <uuid>.json and config.yml.
    # This folder is mounted into cloudflared and backed up, so once the routes are in, it goes —
    # changing the tunnel later starts with a new sign-in (README.md).
    if [ -f "$cfdir/config.yml" ] && [ -f "$cfdir/cert.pem" ]; then
      rm -f "$cfdir/cert.pem"; info "removed the Cloudflare sign-in certificate (the tunnel does not need it)"
    fi
  elif [ "$MODE" = direct ] && [ "$SKIP_DNS" = 0 ]; then
    say "Checking DNS"
    # A name that resolves, but to another machine, used to pass: the install finished "healthy" and
    # printed a setup link that could not open. Said plainly now — the install still finishes (behind
    # a router that forwards 80/443 the public address is rightly not one of this server's own).
    local own bad=() far="" x
    # Docker's own bridges are this server's too, but no name points at them (VM 120 listed docker0).
    own=$(ip -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth)/ {print $4}' | cut -d/ -f1 | sort -u | tr '\n' ' ')
    for h in "$DOMAIN" "api.$DOMAIN" "matrix.$DOMAIN"; do
      a=$(getent ahosts "$h" | awk '{print $1}' | sort -u | tr '\n' ' ')
      [ -n "$a" ] || die "$h does not resolve — point it at this server, then run this again (or --skip-dns-check)"
      info "$h → $a"
      if [ -n "$own" ]; then
        local hit=0
        for x in $a; do case " $own " in *" $x "*) hit=1 ;; esac; done
        if [ "$hit" = 0 ]; then bad+=("$h"); for x in $a; do case " $far " in *" $x "*) ;; *) far="${far:+$far }$x" ;; esac; done; fi
      fi
    done
    if [ "${#bad[@]}" -gt 0 ]; then
      local who="${bad[0]}"
      [ "${#bad[@]}" -lt 2 ] || who="$(IFS=,; printf '%s' "${bad[*]:0:${#bad[@]}-1}" | sed 's/,/, /g') and ${bad[-1]}"
      NAME_WARNING="$who $([ "${#bad[@]}" = 1 ] && echo resolves || echo resolve) to $far, which is not an address of this server (${own% }). Unless this server is behind a router that forwards ports 80 and 443 from that address to it, the site cannot be reached by that name: its certificates will not issue and the setup link will not open. Point the A (or AAAA) records at this server's public address; nothing needs to be installed again."
      printf '   ⚠ %s\n' "$NAME_WARNING" >&2
    fi
  fi
}
NAME_WARNING=""
if [ "${BB_INSTALL_TEST_STOP:-}" = front-door ]; then front_door; echo "install: front door done"; exit 0; fi   # test hook

# ── 5. The bundle's files on the host ───────────────────────────────────────────────────────
say "Installing the bundle's files"
# The command first (replaced by a rename, so a copy of it that is running keeps reading the old
# file), then the rest of the bundle's host files through it — one list, the one an update uses.
changed=""
if ! cmp -s "$BB_HOME/release/install/blackbranch" /usr/local/bin/blackbranch; then
  install -m 755 "$BB_HOME/release/install/blackbranch" /usr/local/bin/blackbranch.new
  mv -f /usr/local/bin/blackbranch.new /usr/local/bin/blackbranch
  changed="/usr/local/bin/blackbranch"$'\n'
fi
changed+=$(BB_HOME="$BB_HOME" /usr/local/bin/blackbranch install-files)
if [ -n "${changed//$'\n'/}" ]; then printf '%s\n' "$changed" | sed '/^$/d; s/^/   updated /'; else info "unchanged"; fi
mkdir -p "$BB_HOME/rendered" "$BB_HOME/state" "$BB_HOME/requests" "$BB_HOME/results" "$BB_HOME/cloudflared" \
  "$BB_HOME/backups" "$BB_HOME/backup-ssh" "$BB_HOME/site-files"
# backups/: the local backup target (encrypted snapshots); backup-ssh/: an SFTP target's key. Root's.
chmod 700 "$BB_HOME/backups" "$BB_HOME/backup-ssh"
# requests/: the site's drop box (uid 1000 in the web container). results/: only root writes it,
# and it is NOT inside the drop box, so the site cannot swap it for a link.
chown 1000:1000 "$BB_HOME/requests"; chmod 1770 "$BB_HOME/requests"
chown root:root "$BB_HOME/results"; chmod 755 "$BB_HOME/results"
# site-files/: the install's own icons and points icon, served at /site-files/ (read-only to the site).
chmod 755 "$BB_HOME/site-files"
systemctl is-enabled -q blackbranch-requests.path 2>/dev/null || systemctl enable -q blackbranch-requests.path
systemctl is-active -q blackbranch-requests.path || systemctl start blackbranch-requests.path

# ── 6. The front door ───────────────────────────────────────────────────────────────────────
front_door

# ── 7. Up ───────────────────────────────────────────────────────────────────────────────────
# A move starts nothing yet: the restore brings the site, its .env (the secrets) and its tunnel,
# then starts everything itself. Starting now would make an empty site the restore must replace —
# and in direct mode ask Let's Encrypt for certificates for names that still point at the old server.
if [ "$MOVING" = 1 ]; then
  exec 9>&-
  say "Ready for the restore"
  cat <<EOF
   Nothing is started yet, and there is no setup link: this server becomes the old one's copy.
   1. Make the backups reachable from here (operate.md, "Moving to a bigger server", step 2).
   2. sudo blackbranch restore latest --with-env      (a bucket or SFTP server: add --from <its address>)
      It brings back the databases, the secrets (.env)$([ "$MODE" = tunnel ] && printf ' and the tunnel —\n      stop the old server first, or both of them answer for the site') and starts the site.
EOF
  [ "$MODE" = direct ] && info "3. Then point the three DNS records ($DOMAIN, api.$DOMAIN, matrix.$DOMAIN) at this server."
  exit 0
fi
# Its own red line says what stopped it and what to do; this one says it is safe to go again.
BB_HOME="$BB_HOME" /usr/local/bin/blackbranch up \
  || die "the services did not all start — the line above says why and what to do. Everything so far is kept: fix that one thing and run the same install command again"
# The services are up on this release: an update may run now (the feed read below is one's first step).
exec 9>&-

say "Installed"
cat <<EOF
   site        https://$DOMAIN
   api         https://api.$DOMAIN
   homeserver  https://matrix.$DOMAIN   (server name $DOMAIN — permanent; federation off)
   values      $ENV_FILE  (back it up — its secrets exist nowhere else)
   operate     sudo blackbranch status · sudo blackbranch logs <service> · sudo blackbranch backup · blackbranch help
               (every command but help needs sudo: the install is root's)
EOF
[ "$MODE" = internal ] && echo "   ⚠ LAB MODE: certificates from caddy's own CA — not for production."
# The update feed, read once now (a box that cannot read it says so on the doctor page).
BB_HOME="$BB_HOME" /usr/local/bin/blackbranch update --check >/dev/null 2>&1 || info "the update feed could not be read yet (blackbranch update --check says why)"
[ -z "$NAME_WARNING" ] || printf '\n   ⚠ %s\n\n' "$NAME_WARNING" >&2
# The one setup link — or, once the first admin exists, where to sign in.
BB_HOME="$BB_HOME" /usr/local/bin/blackbranch setup-link || true
exit 0
