# shellcheck shell=bash
# The homeserver generator: Synapse's homeserver.yaml + log.config, MAS's
# config.yaml, and the router lines for the homeserver's hostname — rendered from plain inputs,
# never edited by hand. Sourced by two callers, so there is ONE generator:
#   install/blackbranch            the bundle (`blackbranch render`), inputs from the install's .env
#   the maintainers' disposable dev/CI install (CI job `matrix`)
#
# Inputs are MX_* variables the caller sets (each function names the ones it reads). Values are
# written into YAML double-quoted, so every input is checked first: a quote, a backslash or a line
# break in one is refused rather than written.
#
# Federation (MX_FEDERATION=on|off) is the one switch an install may flip after it is made:
#   off  no federation listener and an empty federation whitelist — outside servers cannot reach
#        the community and this server reaches no one
#   on   a federation listener on MX_FEDERATION_PORT and no whitelist; the router sends
#        /_matrix/federation/* and /_matrix/key/* to it. The server name does not change.

mx_die() { printf 'render: %s\n' "$*" >&2; return 1; }

# mx_require VAR... — each must be set, non-empty, and safe inside a double-quoted YAML string.
mx_require() {
  local v val
  for v in "$@"; do
    val="${!v-}"
    [ -n "$val" ] || { mx_die "$v is empty"; return 1; }
    case "$val" in *'"'*|*\\*|*$'\n'*|*$'\r'*) mx_die "$v holds a quote, backslash or line break"; return 1 ;; esac
  done
}

# Outgoing mail, optional (A2-05). Reads MX_SMTP_HOST (unset = no mail), MX_SMTP_MODE
# (starttls|tls|plain; unset = starttls), MX_SMTP_PORT (unset = the mode's usual port),
# MX_SMTP_USERNAME + MX_SMTP_PASSWORD (both or neither) and MX_MAIL_FROM_SET (unset = MX_MAIL_FROM).
# Checks them all and sets MX_SMTP_PORT and MX_MAIL_SENDER; writes nothing.
mx_mail_check() {
  [ -n "${MX_SMTP_HOST:-}" ] || return 0
  [[ "$MX_SMTP_HOST" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || { mx_die "MX_SMTP_HOST must be a host name like smtp.example.com"; return 1; }
  MX_SMTP_MODE="${MX_SMTP_MODE:-starttls}"
  case "$MX_SMTP_MODE" in starttls|tls|plain) ;; *) mx_die "MX_SMTP_MODE must be starttls, tls or plain"; return 1 ;; esac
  if [ -z "${MX_SMTP_PORT:-}" ]; then
    case "$MX_SMTP_MODE" in starttls) MX_SMTP_PORT=587 ;; tls) MX_SMTP_PORT=465 ;; plain) MX_SMTP_PORT=25 ;; esac
  fi
  { [[ "$MX_SMTP_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$MX_SMTP_PORT" -ge 1 ] && [ "$MX_SMTP_PORT" -le 65535 ]; } || { mx_die "MX_SMTP_PORT must be 1-65535"; return 1; }
  if [ -n "${MX_SMTP_USERNAME:-}" ]; then
    mx_require MX_SMTP_USERNAME || return 1
    # The password is written single-quoted (any character but a line break; a quote is doubled).
    case "${MX_SMTP_PASSWORD:-}" in *$'\n'*|*$'\r'*) mx_die "MX_SMTP_PASSWORD holds a line break"; return 1 ;; esac
  fi
  MX_MAIL_SENDER="${MX_MAIL_FROM_SET:-$MX_MAIL_FROM}"
  [[ "$MX_MAIL_SENDER" =~ ^[A-Za-z0-9._%+=-]{1,64}@[A-Za-z0-9.-]{1,253}$ ]] || { mx_die "the mail sender must be an address like noreply@example.com"; return 1; }
}
mx_yaml_single() { local s="${1//\'/\'\'}"; printf "'%s'" "$s"; }

# Sign-in providers, optional (signin.* settings, ADR 0154): "Continue with …" on MAS's sign-in page.
# Per slot S of MX_SIGNIN_SLOTS: MX_SIGNIN_<S>_ON (true = offered), MX_SIGNIN_<S>_ID (the provider's
# ULID — MAS keys the provider, and every person's link to it, by it: fixed for Google, Discord and
# Twitch, derived from the issuer for OIDC, so another server never inherits a server's links —
# config/instance-schema.mjs signinProviderId), MX_SIGNIN_<S>_CLIENT_ID,
# MX_SIGNIN_<S>_CLIENT_SECRET, and for OIDC MX_SIGNIN_OIDC_ISSUER and MX_SIGNIN_OIDC_NAME (unset = the
# issuer's host). A slot switched on that cannot render is LEFT OUT with one line saying why, and the
# rest of the config renders: one half-filled card must not stop federation, mail or sign-up applying.
# A provider that leaves the config is disabled by MAS at its next start (gone from the sign-in page,
# every link kept for when the same provider — for OIDC, the same issuer — comes back). Never
# `config sync --prune`: that deletes the links.
MX_SIGNIN_SLOTS="GOOGLE DISCORD TWITCH OIDC"
mx_signin_label() { case "$1" in GOOGLE) echo Google ;; DISCORD) echo Discord ;; TWITCH) echo Twitch ;; OIDC) echo OpenID ;; esac; }
mx_signin_skip() { printf 'render: %s — left out of the sign-in page\n' "$*" >&2; return 1; }
# mx_signin_usable <SLOT> — 0 when the slot is switched on and every value it needs is usable; a slot
# switched on that is not says why on stderr.
mx_signin_usable() {
  local s="$1" label on id cid sec iss name
  label=$(mx_signin_label "$s")
  on="MX_SIGNIN_${s}_ON"; id="MX_SIGNIN_${s}_ID"; cid="MX_SIGNIN_${s}_CLIENT_ID"; sec="MX_SIGNIN_${s}_CLIENT_SECRET"
  [ "${!on:-false}" = true ] || return 1
  # The OpenID address first: its id is derived from it, so a bad address has no id to report on.
  if [ "$s" = OIDC ]; then
    iss="${MX_SIGNIN_OIDC_ISSUER:-}"; name="${MX_SIGNIN_OIDC_NAME:-}"
    [ -n "$iss" ] || { mx_signin_skip "OpenID sign-in is on but has no address"; return 1; }
    # https only: MAS refuses to discover an http:// issuer, so its button would only fail.
    [[ "$iss" =~ ^https://[^[:space:]\"\'\\]{1,247}$ ]] \
      || { mx_signin_skip "OpenID sign-in: the address must start with https:// and hold no space, quote or backslash"; return 1; }
    case "$name" in *$'\n'*|*$'\r'*) mx_signin_skip "OpenID sign-in: the button's name holds a line break"; return 1 ;; esac
  fi
  [[ "${!id:-}" =~ ^[0-7][0-9A-HJKMNP-TV-Z]{25}$ ]] || { mx_signin_skip "$label sign-in: its provider id is not a ULID"; return 1; }
  [ -n "${!cid:-}" ] || { mx_signin_skip "$label sign-in is on but has no client id"; return 1; }
  [[ "${!cid}" =~ ^[A-Za-z0-9._~-]{1,255}$ ]] || { mx_signin_skip "$label sign-in: the client id may hold only letters, digits and . _ ~ -"; return 1; }
  [ -n "${!sec:-}" ] || { mx_signin_skip "$label sign-in is on but has no client secret"; return 1; }
  case "${!sec}" in *$'\n'*|*$'\r'*) mx_signin_skip "$label sign-in: the client secret holds a line break"; return 1 ;; esac
  return 0
}
# mx_render_signin <open|closed> — MAS's upstream_oauth2 block for the usable slots (nothing when none
# is). Sign-up closed: a provider still signs in the people it is linked to, but makes no new account
# without a registration token, as password sign-up makes none.
mx_render_signin() {
  local s any="" tok=false id cid sec host
  [ "$1" = open ] || tok=true
  for s in $MX_SIGNIN_SLOTS; do
    mx_signin_usable "$s" || continue
    if [ -z "$any" ]; then
      echo "# Sign-in with another account (signin.* settings). A user name a provider offers is only suggested:"
      echo "# MAS never links a provider to an existing account by its name."
      echo "upstream_oauth2:"
      echo "  providers:"
      any=1
    fi
    id="MX_SIGNIN_${s}_ID"; cid="MX_SIGNIN_${s}_CLIENT_ID"; sec="MX_SIGNIN_${s}_CLIENT_SECRET"
    echo "    - id: \"${!id}\""
    case "$s" in
      GOOGLE) echo "      human_name: 'Google'"; echo "      brand_name: google"; echo '      issuer: "https://accounts.google.com"' ;;
      DISCORD) echo "      human_name: 'Discord'"; echo "      brand_name: discord"; echo '      issuer: "https://discord.com"' ;;
      TWITCH) echo "      human_name: 'Twitch'"; echo '      issuer: "https://id.twitch.tv/oauth2"' ;;
      OIDC)
        host="${MX_SIGNIN_OIDC_ISSUER#*://}"; host="${host%%/*}"
        echo "      human_name: $(mx_yaml_single "${MX_SIGNIN_OIDC_NAME:-$host}")"
        echo "      issuer: \"$MX_SIGNIN_OIDC_ISSUER\"" ;;
    esac
    echo "      client_id: \"${!cid}\""
    echo "      client_secret: $(mx_yaml_single "${!sec}")"
    case "$s" in
      OIDC) echo "      token_endpoint_auth_method: client_secret_basic" ;;
      *) echo "      token_endpoint_auth_method: client_secret_post" ;;
    esac
    case "$s" in
      GOOGLE|OIDC) echo '      scope: "openid profile email"' ;;
      DISCORD)
        # Discord's user name and chosen display name come from its own API, not the id token.
        echo '      scope: "openid identify email"'
        echo "      fetch_userinfo: true"
        echo '      userinfo_endpoint: "https://discord.com/api/users/@me"' ;;
      TWITCH)
        # Twitch puts the user name and address in the id token only when they are asked for by name.
        echo '      scope: "openid user:read:email"'
        echo "      additional_authorization_parameters:"
        echo "        claims: '{\"id_token\":{\"preferred_username\":null,\"email\":null,\"email_verified\":null}}'" ;;
    esac
    echo "      registration_token_required: $tok"
    # No address is imported: MAS 1.26 stores an imported address as verified whatever the provider
    # said (link.rs complete_authentication_with_upstream), and a template's truthiness cannot be
    # trusted to read a provider's "verified" claim. A person adds an address on their account page,
    # where MAS checks it itself.
    echo "      claims_imports:"
    case "$s" in
      GOOGLE)
        # A Google name is the person's own: never offered as their name here; they pick one.
        cat <<'EOF'
        localpart:
          action: ignore
        displayname:
          action: ignore
        email:
          action: ignore
        account_name:
          template: "{{ user.email }}"
EOF
        ;;
      DISCORD)
        cat <<'EOF'
        localpart:
          action: suggest
          template: "{{ user.username }}"
        displayname:
          action: suggest
          template: "{{ user.global_name }}"
        email:
          action: ignore
        account_name:
          template: "{{ user.username }}"
EOF
        ;;
      TWITCH)
        cat <<'EOF'
        localpart:
          action: suggest
          template: "{{ user.preferred_username | lower }}"
        displayname:
          action: suggest
          template: "{{ user.preferred_username }}"
        email:
          action: ignore
        account_name:
          template: "{{ user.preferred_username }}"
EOF
        ;;
      OIDC)
        cat <<'EOF'
        localpart:
          action: suggest
          template: "{{ user.preferred_username }}"
        displayname:
          action: suggest
          template: "{{ user.name }}"
        email:
          action: ignore
        account_name:
          template: "{{ user.preferred_username }}"
EOF
        ;;
    esac
  done
  return 0
}

mx_federation_on() {
  case "${MX_FEDERATION:-off}" in on) return 0 ;; off) return 1 ;; *) mx_die "MX_FEDERATION must be on or off"; return 2 ;; esac
}

# Synapse. Reads: MX_SERVER_NAME MX_PUBLIC_BASEURL MX_CONFIG_DIR MX_DATA_DIR MX_DB_HOST MX_DB_NAME
# MX_DB_USER MX_DB_PASSWORD MX_REGISTRATION_SECRET MX_MACAROON_SECRET MX_FORM_SECRET MX_MAS_ENDPOINT
# MX_MAS_SECRET MX_FEDERATION MX_FEDERATION_PORT MX_X_FORWARDED (true|false), and the optional
# MX_MAX_UPLOAD (the largest upload Synapse takes, e.g. 20M; unset = 20M) and, both or neither,
# MX_COMMUNITY_LOCALPART + MX_COMMUNITY_REGISTRATION (the service account's name, and where Synapse
# reads its registration: mx_render_appservice_community below), and MX_RETENTION_CAP_DAYS (the
# install's retention cap, community.retentionCapDays: whole days, 0 = no limit), and the optional
# MX_OOYE_REGISTRATION (where Synapse reads the Discord bridge's registration, while the bridge is
# switched on: mx_render_appservice_ooye below).
mx_render_homeserver() {
  mx_require MX_SERVER_NAME MX_PUBLIC_BASEURL MX_CONFIG_DIR MX_DATA_DIR MX_DB_HOST MX_DB_NAME MX_DB_USER \
    MX_DB_PASSWORD MX_REGISTRATION_SECRET MX_MACAROON_SECRET MX_FORM_SECRET MX_MAS_ENDPOINT MX_MAS_SECRET || return 1
  local fed=0 xf="${MX_X_FORWARDED:-false}" svc=0
  if [ -n "${MX_COMMUNITY_LOCALPART:-}${MX_COMMUNITY_REGISTRATION:-}" ]; then
    mx_require MX_COMMUNITY_LOCALPART MX_COMMUNITY_REGISTRATION || return 1
    mx_community_localpart_ok || return 1
    svc=1
  fi
  if [ -n "${MX_OOYE_REGISTRATION:-}" ]; then mx_require MX_OOYE_REGISTRATION || return 1; fi
  if mx_federation_on; then fed=1; else [ $? -eq 1 ] || return 1; fi
  case "$xf" in true|false) ;; *) mx_die "MX_X_FORWARDED must be true or false"; return 1 ;; esac
  local upload="${MX_MAX_UPLOAD:-20M}"
  [[ "$upload" =~ ^[1-9][0-9]{0,5}[KMG]?$ ]] || { mx_die "MX_MAX_UPLOAD must be a size like 20M (digits, then K, M or G)"; return 1; }
  local cap="${MX_RETENTION_CAP_DAYS-}"
  if ! [[ "$cap" =~ ^(0|[1-9][0-9]{0,3})$ ]] || [ "$cap" -gt 3650 ]; then
    mx_die "MX_RETENTION_CAP_DAYS must be whole days from 0 (no limit) to 3650"; return 1
  fi
  cat <<EOF
# GENERATED by the homeserver generator (install/matrix/render.sh) — never edit by hand; the next
# render overwrites it. Federation: $([ "$fed" = 1 ] && echo on || echo off).
server_name: "$MX_SERVER_NAME"
public_baseurl: "$MX_PUBLIC_BASEURL"
pid_file: $MX_DATA_DIR/homeserver.pid
# The site serves /.well-known/matrix/* itself, from the same install values.
serve_server_wellknown: false
listeners:
  - port: 8008
    type: http
    tls: false
    x_forwarded: $xf
    bind_addresses: ["0.0.0.0"]
    resources:
      - names: [client]
        compress: false
EOF
  if [ "$fed" = 1 ]; then
    : "${MX_FEDERATION_PORT:?MX_FEDERATION_PORT is needed when federation is on}"
    cat <<EOF
  # Federation on: other servers reach this listener (/_matrix/federation, /_matrix/key).
  - port: $MX_FEDERATION_PORT
    type: http
    tls: false
    x_forwarded: $xf
    bind_addresses: ["0.0.0.0"]
    resources:
      - names: [federation]
        compress: false
EOF
  fi
  cat <<EOF
database:
  name: psycopg2
  args:
    user: "$MX_DB_USER"
    password: "$MX_DB_PASSWORD"
    database: "$MX_DB_NAME"
    host: "$MX_DB_HOST"
    cp_min: 2
    cp_max: 10
log_config: $MX_CONFIG_DIR/log.config
media_store_path: $MX_DATA_DIR/media_store
# The largest file anyone may upload (MX_MAX_UPLOAD; Synapse's own default, 50M, is more than a chat
# community needs on one small box).
max_upload_size: "$upload"
# Generated once, beside the media; never regenerated (its loss is unrecoverable).
signing_key_path: $MX_DATA_DIR/signing.key
report_stats: false
registration_shared_secret: "$MX_REGISTRATION_SECRET"
macaroon_secret_key: "$MX_MACAROON_SECRET"
form_secret: "$MX_FORM_SECRET"
EOF
  if [ "$fed" = 1 ]; then
    cat <<'EOF'
# Federation on: any server may federate. Keys of other servers are fetched from those servers
# themselves, never through a third-party notary.
trusted_key_servers: []
EOF
  else
    cat <<'EOF'
# Federation off: a closed island — no federation listener, nobody on the whitelist, no key servers.
federation_domain_whitelist: []
trusted_key_servers: []
EOF
  fi
  cat <<EOF
# Accounts and sign-in belong to MAS.
matrix_authentication_service:
  enabled: true
  endpoint: "$MX_MAS_ENDPOINT"
  secret: "$MX_MAS_SECRET"
# The site's mod-power code assumes the room v12 creator rule.
default_room_version: "12"
# The public room list holds the rooms the service account lists and the bootstrap's three, and
# nothing else. Listing a room still takes that room's own power. Synapse applies these rules to a
# server admin too, so the bootstrap's aliases stay while the streamer's account makes those rooms.
room_list_publication_rules:
EOF
  if [ "$svc" = 1 ]; then
    cat <<EOF
  - user_id: "@$MX_COMMUNITY_LOCALPART:$MX_SERVER_NAME"
    action: allow
EOF
  fi
  cat <<EOF
  - alias: "#community-hub:$MX_SERVER_NAME"
    action: allow
  - alias: "#general:$MX_SERVER_NAME"
    action: allow
  - alias: "#forum:$MX_SERVER_NAME"
    action: allow
  - action: deny
# Avatars for signed-out visitors need unauthenticated profile reads (the default, stated).
require_auth_for_profile_requests: false
EOF
  # Retention follows the install's cap (spec 2026-10-23 §4.5, ADR 0139), so the Community page's
  # words are true: Synapse gives a room with no max_lifetime of its own the server's default, and
  # cuts a longer room value to allowed_lifetime_max, so "forever" is real only with neither.
  # Synapse durations: m is MINUTES, not months.
  if [ "$cap" = 0 ]; then
    cat <<'EOF'
# No cap: no server default and no longest. A room keeps messages as long as its own policy says,
# and forever when it says nothing.
retention:
  enabled: true
  allowed_lifetime_min: 1d
EOF
  else
    cat <<EOF
# The install's cap: a room without its own policy (every DM) keeps messages $cap days, and no room
# may keep them longer.
retention:
  enabled: true
  default_policy:
    max_lifetime: ${cap}d
  allowed_lifetime_min: 1d
  allowed_lifetime_max: ${cap}d
EOF
  fi
  cat <<EOF
experimental_features:
  # Extended profile fields: the username colour.
  msc4133_enabled: true
EOF
  if [ "$svc" = 1 ] || [ -n "${MX_OOYE_REGISTRATION:-}" ]; then
    # The install's application services: the community service account (no sign-up, no MAS
    # account), and the Discord bridge while it is switched on.
    if [ "$svc" = 1 ]; then echo "# The install's community service account (an application service: no sign-up, no MAS account)."; fi
    echo "app_service_config_files:"
    if [ "$svc" = 1 ]; then echo "  - \"$MX_COMMUNITY_REGISTRATION\""; fi
    if [ -n "${MX_OOYE_REGISTRATION:-}" ]; then echo "  - \"$MX_OOYE_REGISTRATION\""; fi
  fi
}

# The retention cap's default, read from the settings schema's own entry (config/instance-schema.mjs,
# community.retentionCapDays) so the number lives in one place. Both callers pass the schema file.
mx_retention_cap_default() { # mx_retention_cap_default <schema file> → the default days
  local d
  d=$(sed -n "s/^.*key: 'community\.retentionCapDays',.* default: \([0-9][0-9]*\),.*$/\1/p" "$1" 2>/dev/null | head -n 1)
  [ -n "$d" ] || { mx_die "could not read community.retentionCapDays's default from $1"; return 1; }
  printf '%s\n' "$d"
}

mx_community_localpart_ok() {
  [[ "$MX_COMMUNITY_LOCALPART" =~ ^[a-z0-9._=-]{1,64}$ ]] \
    || { mx_die "MX_COMMUNITY_LOCALPART must be a Matrix user name: 1-64 of a-z 0-9 . _ = -"; return 1; }
}

# The community service account's registration (Synapse's app_service_config_files). Synapse makes
# the sender exist from this file alone: never register it (/register answers 500 once its profile
# exists). MAS refuses that name at sign-up (spike 0.1 P9: M_EXCLUSIVE; mx_render_mas also bans it), and
# Synapse's admin API refuses its token. The host renders this only while the name is nobody's.
# No url: Synapse pushes nothing to it. Reads: MX_COMMUNITY_LOCALPART MX_COMMUNITY_AS_TOKEN
# MX_COMMUNITY_HS_TOKEN MX_SERVER_NAME.
mx_render_appservice_community() {
  mx_require MX_COMMUNITY_LOCALPART MX_COMMUNITY_AS_TOKEN MX_COMMUNITY_HS_TOKEN MX_SERVER_NAME || return 1
  mx_community_localpart_ok || return 1
  local t re
  for t in MX_COMMUNITY_AS_TOKEN MX_COMMUNITY_HS_TOKEN; do
    [[ "${!t}" =~ ^[0-9a-f]{32,128}$ ]] || { mx_die "$t must be 16-64 random bytes as hex"; return 1; }
  done
  # The one account, anchored; a dot is a dot. The backslash is doubled: the value is a YAML "string".
  re="@$MX_COMMUNITY_LOCALPART:$MX_SERVER_NAME"
  re="${re//./\\\\.}"
  cat <<EOF
# GENERATED by the homeserver generator (install/matrix/render.sh) — never edit by hand; the next
# render overwrites it. The install's community service account.
id: community
url: null
as_token: "$MX_COMMUNITY_AS_TOKEN"
hs_token: "$MX_COMMUNITY_HS_TOKEN"
sender_localpart: "$MX_COMMUNITY_LOCALPART"
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "^$re\$"
  rooms: []
  aliases: []
EOF
}

mx_render_log_config() {
  cat <<'EOF'
# GENERATED by the homeserver generator — never edit by hand.
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
EOF
}

# Sign-up (MX_REGISTRATION=open|closed): whether anyone may make an account on MAS's own pages.
# Unset, it is resolved here from the install's settings, because this generator is what every
# render — the CLI, the site's `render` request, the doctor's comparison — goes through:
#   • setup NOT finished (`setup.completedAt` unset): closed, whatever the switch says. The setup
#     pages make the first admin through the admin API, so nobody needs sign-up yet — and open
#     sign-up then let anyone claim the community's aliases before the bootstrap made them;
#   • setup finished: the switch `matrix.registration` (Admin Panel → Site), unset = closed: an
#     open sign-up page on the internet is the operator's choice to make, never a default;
#   • the database down: what the last render wrote, so a restart never flips sign-up; no earlier
#     render (a first install) = closed.
# The settings are read through the host's own readers (install/blackbranch: postgres_up,
# config_get) when this file is sourced there; a caller without them (the maintainers' disposable
# install) sets MX_REGISTRATION itself, or gets closed.
mx_registration_state() {
  local v finished prev="${BB_HOME:-}/rendered/mas/config.yaml"
  if declare -F postgres_up >/dev/null && declare -F config_get >/dev/null && postgres_up \
     && finished=$(config_get setup.completedAt 2>/dev/null) && v=$(config_get matrix.registration 2>/dev/null); then
    [ -n "$finished" ] || { echo closed; return 0; }
    case "${v:-closed}" in open|closed) echo "${v:-closed}" ;; *) mx_die "matrix.registration must be open or closed (it is \"$v\")"; return 1 ;; esac
    return 0
  fi
  if [ -n "${BB_HOME:-}" ] && grep -q '^  password_registration_enabled: true$' "$prev" 2>/dev/null; then echo open; else echo closed; fi
}

# MAS. Reads: MX_ISSUER MX_SERVER_NAME MX_MAS_DB_URI MX_MAIL_FROM MX_CLIENT_ID MX_CLIENT_SECRET
# MX_REDIRECT_URI MX_SYNAPSE_ENDPOINT MX_MAS_SECRET MX_ENCRYPTION_SECRET MX_MAS_KEYS_FILE, and the
# optional MX_TRUSTED_PROXIES (space-separated CIDRs; unset = MAS's own private-range default),
# MX_CLIENT_NAME and MX_CLIENT_URI (the site's name and https origin on the consent screen), and
# MX_REGISTRATION (open|closed; unset = mx_registration_state above), and MX_COMMUNITY_LOCALPART (the
# community service account's name, banned from sign-up; unset = no ban), and the optional sign-in
# providers' MX_SIGNIN_* (mx_render_signin above).
#
# MAS serves from the root of its listener. When the issuer has a path (the bundle's
# https://matrix.<domain>/auth/), the router strips that path before handing a request on, and MAS
# builds every link from the issuer — so one MAS config works with or without a path.
mx_render_mas() {
  mx_require MX_ISSUER MX_SERVER_NAME MX_MAS_DB_URI MX_MAIL_FROM MX_CLIENT_ID MX_CLIENT_SECRET MX_REDIRECT_URI \
    MX_SYNAPSE_ENDPOINT MX_MAS_SECRET MX_ENCRYPTION_SECRET MX_MAS_KEYS_FILE || return 1
  mx_mail_check || return 1
  # Optional: the site's name and address on MAS's consent screen, checked like every other input.
  if [ -n "${MX_CLIENT_NAME:-}" ]; then mx_require MX_CLIENT_NAME || return 1; fi
  if [ -n "${MX_CLIENT_URI:-}" ]; then
    mx_require MX_CLIENT_URI || return 1
    [[ "$MX_CLIENT_URI" =~ ^https://[^/[:space:]]+/$ ]] || { mx_die "MX_CLIENT_URI must be an https origin with a trailing /"; return 1; }
  fi
  [[ "$MX_ENCRYPTION_SECRET" =~ ^[0-9a-f]{64}$ ]] || { mx_die "MX_ENCRYPTION_SECRET must be 32 bytes as hex"; return 1; }
  [[ "$MX_CLIENT_ID" =~ ^[0-9A-HJKMNP-TV-Z]{26}$ ]] || { mx_die "MX_CLIENT_ID must be a ULID"; return 1; }
  if [ ! -s "$MX_MAS_KEYS_FILE" ] || ! grep -q '^  keys:$' "$MX_MAS_KEYS_FILE"; then
    mx_die "no MAS signing keys at $MX_MAS_KEYS_FILE"; return 1
  fi
  local p reg="${MX_REGISTRATION:-}"
  [ -n "$reg" ] || reg=$(mx_registration_state) || return 1
  case "$reg" in open|closed) ;; *) mx_die "MX_REGISTRATION must be open or closed"; return 1 ;; esac
  cat <<EOF
# GENERATED by the homeserver generator (install/matrix/render.sh) — never edit by hand; the next
# render overwrites it.
http:
  public_base: "$MX_ISSUER"
  issuer: "$MX_ISSUER"
  listeners:
    - name: web
      resources:
        - name: discovery
        - name: human
        - name: oauth
        - name: compat
        - name: graphql
        - name: assets
        - name: health
      binds:
        - address: "[::]:8080"
    # The admin API, on a listener the router never sends anything to. A token for it comes from
    # the site client's secret alone and may set any account's password, so it must not be one
    # secret away from the internet. The site reaches it inside the network (MAS_ADMIN_URL):
    # "Delete my account", and the setup pages' first admin.
    - name: internal
      resources:
        - name: health
        - name: adminapi
      binds:
        - address: "[::]:8081"
EOF
  if [ -n "${MX_TRUSTED_PROXIES:-}" ]; then
    echo "  # Only the router may say who the client is."
    echo "  trusted_proxies:"
    for p in $MX_TRUSTED_PROXIES; do
      [[ "$p" =~ ^[0-9a-fA-F:.]+/[0-9]{1,3}$ ]] || { mx_die "MX_TRUSTED_PROXIES: \"$p\" is not a CIDR"; return 1; }
      echo "    - \"$p\""
    done
  fi
  local mail=false; [ -n "${MX_SMTP_HOST:-}" ] && mail=true
  cat <<EOF
database:
  uri: "$MX_MAS_DB_URI"
EOF
  if [ "$mail" = true ]; then
    cat <<EOF
# Outgoing mail through the install's mail server (mail.* settings): password recovery and a
# verified address at sign-up depend on it.
email:
  from: "$MX_MAIL_SENDER"
  reply_to: "$MX_MAIL_SENDER"
  transport: smtp
  mode: $MX_SMTP_MODE
  hostname: "$MX_SMTP_HOST"
  port: $MX_SMTP_PORT
EOF
    if [ -n "${MX_SMTP_USERNAME:-}" ]; then
      echo "  username: \"$MX_SMTP_USERNAME\""
      echo "  password: $(mx_yaml_single "${MX_SMTP_PASSWORD:-}")"
    fi
  else
    cat <<EOF
# No mail server is set: mail is dropped, so nothing may depend on it.
email:
  from: "$MX_MAIL_FROM"
  reply_to: "$MX_MAIL_FROM"
  transport: blackhole
EOF
  fi
  cat <<EOF
passwords:
  enabled: true
  schemes:
    - version: 1
      algorithm: argon2id
  minimum_complexity: 3
# Sign-up: $reg (closed until setup is finished, then the Admin Panel's switch). With a mail server,
# a new account verifies its address and a forgotten password is recovered by mail; without one,
# neither — an address nothing can verify would lock everyone out.
account:
  password_registration_enabled: $([ "$reg" = open ] && echo true || echo false)
  password_registration_email_required: $mail
  password_recovery_enabled: $mail
matrix:
  kind: synapse
  homeserver: "$MX_SERVER_NAME"
  secret: "$MX_MAS_SECRET"
  endpoint: "$MX_SYNAPSE_ENDPOINT"
# The site: a confidential client. Its one redirect URI is the site's sign-in callback.
clients:
  - client_id: "$MX_CLIENT_ID"
    client_auth_method: client_secret_basic
    client_secret: "$MX_CLIENT_SECRET"
    redirect_uris:
      - "$MX_REDIRECT_URI"
EOF
  # What the consent screen calls the site ("Continue to <name>?") — without it MAS shows the ULID.
  if [ -n "${MX_CLIENT_NAME:-}" ]; then echo "    client_name: \"$MX_CLIENT_NAME\""; fi
  if [ -n "${MX_CLIENT_URI:-}" ]; then echo "    client_uri: \"$MX_CLIENT_URI\""; fi
  cat <<EOF
# The same client may use the admin API (scope urn:mas:admin): self-serve "Delete my account"
# deactivates the person's Matrix account with erase.
policy:
  data:
    admin_clients:
      - "$MX_CLIENT_ID"
EOF
  # The community service account's name is nobody's to sign up with. MAS already honours the app
  # service's exclusive namespace (spike 0.1 P9: sign-up with the name answers M_EXCLUSIVE); this is
  # the sign-up policy's own ban list besides (MAS 1.26 policy data registration.banned_usernames).
  # The Discord bridge's names (@_ooye_…) are its alone, switched on or not: the reconciler counts
  # every account in that namespace as the bridge's, so nobody may take one before it is switched on
  # (while it is on, Synapse's exclusive namespace refuses them too).
  echo "    registration:"
  echo "      banned_usernames:"
  if [ -n "${MX_COMMUNITY_LOCALPART:-}" ]; then
    mx_community_localpart_ok || return 1
    cat <<EOF
        literals:
          - "$MX_COMMUNITY_LOCALPART"
EOF
  fi
  cat <<EOF
        prefixes:
          - "$MX_OOYE_PREFIX"
EOF
  mx_render_signin "$reg"
  cat <<EOF
secrets:
  encryption: "$MX_ENCRYPTION_SECRET"
EOF
  cat "$MX_MAS_KEYS_FILE"
}

# The Discord bridge (Out Of Your Element, compose profile `discord`): its application service
# registration. OOYE reads every setting from this one file and has no environment variables. It is
# JSON (OOYE reads it with JSON.parse), which Synapse reads as YAML. The bridge's copy carries the
# `ooye` block, the bot token among it; Synapse's copy (`synapse`) is the same file without that block.
# The shape ran end to end in spike 0.2 (vault briefs/community-1023/spikes.md §0.2):
#   url, server_origin  inside the bundle network (Synapse pushes to ooye:6693, OOYE asks synapse:8008)
#   bridge_origin       the site's own host under /bridge (render_caddyfile routes it)
#   web_password        derived from the as_token and shown nowhere: the bridge page's own "add the bot"
#                       actions would let any Discord server's manager bridge it into this homeserver.
#                       The panel links rooms without them (Slice 2 task 2.4).
#   receive_ephemeral   true, or OOYE rewrites the file (it is read-only to the bridge)
# Reads: MX_SERVER_NAME MX_OOYE_AS_TOKEN MX_OOYE_HS_TOKEN MX_OOYE_BRIDGE_ORIGIN, and the optional
# MX_OOYE_DISCORD_TOKEN (empty: the bridge waits for one) and MX_OOYE_CLIENT_SECRET (empty: no
# "log in with Discord" on the bridge page).
MX_OOYE_PREFIX=_ooye_
# The bridge's accounts as its registration claims them (the reconciler's feed copies it unchanged).
mx_ooye_user_regex() { local s="${MX_SERVER_NAME//./\\.}"; printf '@%s.*:%s' "$MX_OOYE_PREFIX" "$s"; }
mx_ooye_alias_regex() { local s="${MX_SERVER_NAME//./\\.}"; printf '#%s.*:%s' "$MX_OOYE_PREFIX" "$s"; }
mx_ooye_sender() { printf '@%sbot:%s' "$MX_OOYE_PREFIX" "$MX_SERVER_NAME"; }
mx_json_bs() { local s="$1"; printf '%s' "${s//\\/\\\\}"; }
mx_render_appservice_ooye() { # mx_render_appservice_ooye [synapse]
  mx_require MX_SERVER_NAME MX_OOYE_AS_TOKEN MX_OOYE_HS_TOKEN MX_OOYE_BRIDGE_ORIGIN || return 1
  [[ "$MX_SERVER_NAME" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || { mx_die "MX_SERVER_NAME must be a host name like example.com"; return 1; }
  local t
  for t in MX_OOYE_AS_TOKEN MX_OOYE_HS_TOKEN; do
    [[ "${!t}" =~ ^[0-9a-f]{32,128}$ ]] || { mx_die "$t must be 16-64 random bytes as hex"; return 1; }
  done
  [ "$MX_OOYE_AS_TOKEN" != "$MX_OOYE_HS_TOKEN" ] || { mx_die "MX_OOYE_AS_TOKEN and MX_OOYE_HS_TOKEN must differ"; return 1; }
  [[ "$MX_OOYE_BRIDGE_ORIGIN" =~ ^https://[a-z0-9.-]+/bridge$ ]] || { mx_die "MX_OOYE_BRIDGE_ORIGIN must be https://<domain>/bridge"; return 1; }
  [[ "${MX_OOYE_DISCORD_TOKEN:-}" =~ ^([A-Za-z0-9_.-]{20,200})?$ ]] || { mx_die "DISCORD_BOT_TOKEN is not a Discord bot token (letters, digits and . _ - only)"; return 1; }
  [[ "${MX_OOYE_CLIENT_SECRET:-}" =~ ^([A-Za-z0-9_-]{16,128})?$ ]] || { mx_die "DISCORD_CLIENT_SECRET is not a Discord client secret (letters, digits and _ - only)"; return 1; }
  local head pw
  head="{\"id\":\"ooye\",\"as_token\":\"$MX_OOYE_AS_TOKEN\",\"hs_token\":\"$MX_OOYE_HS_TOKEN\",\"url\":\"http://ooye:6693\",\"sender_localpart\":\"${MX_OOYE_PREFIX}bot\""
  head+=",\"namespaces\":{\"users\":[{\"exclusive\":true,\"regex\":\"$(mx_json_bs "$(mx_ooye_user_regex)")\"}],\"aliases\":[{\"exclusive\":true,\"regex\":\"$(mx_json_bs "$(mx_ooye_alias_regex)")\"}]}"
  head+=",\"protocols\":[\"discord\"],\"rate_limited\":false,\"receive_ephemeral\":true,\"socket\":6693"
  if [ "${1:-}" = synapse ]; then printf '%s}\n' "$head"; return 0; fi
  pw=$(printf 'ooye web_password\n%s' "$MX_OOYE_AS_TOKEN" | sha256sum | cut -c1-64)
  [[ "$pw" =~ ^[0-9a-f]{64}$ ]] || { mx_die "could not derive the bridge page's password (sha256sum)"; return 1; }
  printf '%s,"ooye":{"namespace_prefix":"%s","server_name":"%s","server_origin":"http://synapse:8008","bridge_origin":"%s","discord_token":"%s","discord_client_secret":"%s","web_password":"%s","max_file_size":5000000,"content_length_workaround":false,"include_user_id_in_mxid":false,"invite":[],"receive_presences":false}}\n' \
    "$head" "$MX_OOYE_PREFIX" "$MX_SERVER_NAME" "$MX_OOYE_BRIDGE_ORIGIN" "${MX_OOYE_DISCORD_TOKEN:-}" "${MX_OOYE_CLIENT_SECRET:-}" "$pw"
}

# MAS's signing keys: generated ONCE by MAS itself (`config generate`), only its `keys:` list kept.
# mx_generate_mas_keys <mas image> <file> — never overwrites an existing file.
mx_generate_mas_keys() {
  local image="$1" out="$2" tmp
  [ -s "$out" ] && return 0
  tmp=$(mktemp "$(dirname "$out")/.mas-keys.XXXXXX")
  chmod 600 "$tmp"
  docker run --rm "$image" config generate 2>/dev/null \
    | awk '/^secrets:/{s=1; next} s && /^[^ ]/{s=0} s && /^  keys:/{k=1; print; next} s && k && /^  [^ -]/{k=0} s && k {print}' > "$tmp"
  if ! grep -q '^  keys:$' "$tmp" || ! grep -q 'PRIVATE KEY-----' "$tmp"; then
    rm -f "$tmp"; mx_die "MAS key generation produced no keys"; return 1
  fi
  mv -f "$tmp" "$out"
}

# The router lines for the homeserver's hostname, inside its site block. Reads: MX_FEDERATION,
# MX_ISSUER_PATH (the issuer's path, e.g. /auth — MAS is served under it), MX_FEDERATION_PORT.
mx_caddy_routes() {
  local fed=0 ip="${MX_ISSUER_PATH:-/auth}"
  if mx_federation_on; then fed=1; else [ $? -eq 1 ] || return 1; fi
  [[ "$ip" =~ ^/[a-z0-9_-]+$ ]] || { mx_die "MX_ISSUER_PATH must be one path segment like /auth"; return 1; }
  cat <<EOF
	# MAS: its pages and API under the issuer's path (stripped — MAS serves from its root), and the
	# Matrix login endpoints it answers for the homeserver.
	handle_path $ip/* {
		import upstream mas:8080
	}
	@mas_compat path /_matrix/client/*/login /_matrix/client/*/login/* /_matrix/client/*/logout /_matrix/client/*/logout/* /_matrix/client/*/refresh
	handle @mas_compat {
		import upstream mas:8080
	}
	@federation path /_matrix/federation/* /_matrix/key/*
EOF
  if [ "$fed" = 1 ]; then
    cat <<EOF
	# Federation ON: other servers reach Synapse's federation listener.
	handle @federation {
		import upstream synapse:${MX_FEDERATION_PORT:?}
	}
EOF
  else
    cat <<'EOF'
	# Federation OFF: nothing answers for other servers.
	handle @federation {
		respond 404
	}
EOF
  fi
  cat <<'EOF'
	handle /_matrix/* {
		import upstream synapse:8008
	}
	handle /_synapse/client/* {
		import upstream synapse:8008
	}
	handle {
		respond 404
	}
EOF
}
