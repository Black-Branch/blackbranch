#!/usr/bin/env bash
# The backup image's one script. `blackbranch` runs it through Compose — never by hand —
# as one of three services (install/compose.yaml), each with only the rights its mode needs:
#
#   backup   backup <keepDaily> <keepWeekly>  the three databases dumped in one run into /bb/db with a
#                                       manifest; then ONE snapshot of /bb/db, Synapse's media store
#                                       and signing key, and /bb/home (.env, MAS's keys, the tunnel's
#                                       credentials); then forget + prune to the retention
#   backup   check                      does the target answer, and does the passphrase open it
#   backup   snapshots                  the snapshots, as restic lists them
#   backup   key                        the SFTP key (made once); prints its public half
#   verify   verify <snapshot>          restic's own check; the snapshot restored into /scratch; the
#                                       dumps loaded into a Postgres started HERE on a unix socket
#                                       (this service has no database password and no live data);
#                                       then verify.mjs judges what came back
#   restore  restore-stage <snapshot>   the dumps and the install's files into /scratch (the host
#                                       compares the secrets before anything live is touched)
#   restore  restore-db                 the staged dumps replace the three live databases
#   restore  restore-media <snapshot>   Synapse's media store and signing key back into synapse-data
#   restore  clean                      empties /scratch (what the container wrote, it removes)
#
# Progress goes to stderr. The last line on stdout is `BBRESULT {json}` — the host reads nothing
# else. Secrets arrive in the environment (RESTIC_PASSWORD, the target's keys), never as arguments,
# and the target's address is cut out of every message.
set -euo pipefail

DATABASES=(stream synapse mas)
HOST_TAG=blackbranch
SNAP_RE='^(latest|[0-9a-f]{8,64})$'

log() { printf '   %s\n' "$*" >&2; }
# The target's host (a bucket's endpoint, an SFTP server), "" for this server's folder.
target_host() { local x="${RESTIC_REPOSITORY:-}"; x="${x#s3:}"; x="${x#sftp:}"; x="${x#*://}"; x="${x#*@}"; printf '%s' "${x%%[:/]*}"; }
# A bucket's name: the first folder of an s3: address (s3:https://<endpoint>/<bucket>[/<folder>]).
target_bucket() { local x="${RESTIC_REPOSITORY#s3:}"; x="${x#*://}"; x="${x#*/}"; printf '%s' "${x%%/*}"; }
jstr() { # a JSON string: the target's address and host cut out, control characters and quotes dropped
  local s="$1" h; h=$(target_host)
  if [ -n "${RESTIC_REPOSITORY:-}" ]; then s="${s//"$RESTIC_REPOSITORY"/<target>}"; fi
  if [ -n "$h" ]; then s="${s//"$h"/<target>}"; fi
  # shellcheck disable=SC1003 # the set really is control characters, double quote, backslash
  s=$(printf '%s' "$s" | tr '\n\t' '  ' | tr -d '\000-\037\177"\\' | cut -c1-400)
  printf '"%s"' "$s"
}
result() { printf 'BBRESULT %s\n' "$1"; }
fail() { # fail <message> — the mode's result, then a non-zero exit
  result "{\"ok\":false,\"message\":$(jstr "$1")}"
  exit 1
}

# Where restic may connect: never taken as given. The host passes the SETTING (BK_TARGET,
# BK_REPOSITORY); target-check.mjs applies the settings layer's own rule, refuses loopback,
# link-local, multicast and the bundle's network, and pins the checked address in this container's
# /etc/hosts. Only then is RESTIC_REPOSITORY set — this server's folder for local. Every mode that
# runs restic calls this first.
restic_opts=()
target_ready() {
  local out
  if ! out=$(node /bb-backup/target-check.mjs 2>&1); then fail "the backup address is refused: $out"; fi
  case "${BK_TARGET:-local}" in
    local) RESTIC_REPOSITORY=/backups/restic ;;
    *) RESTIC_REPOSITORY="$BK_REPOSITORY" ;;
  esac
  export RESTIC_REPOSITORY
  # SFTP: the box's own key, and the server's key learned once.
  if [[ "$RESTIC_REPOSITORY" == sftp:* ]]; then
    restic_opts=(-o "sftp.args=-i /bb-ssh/id_ed25519 -o UserKnownHostsFile=/bb-ssh/known_hosts -o StrictHostKeyChecking=accept-new -o BatchMode=yes")
  fi
}
r() { restic "${restic_opts[@]}" "$@"; }
# What restic said went wrong, for a message: its first error line (the cause, e.g. "ciphertext
# verification failed"), then its last line (the verdict).
r_err() {
  local f; f=$(mktemp)
  if r "$@" 2>"$f"; then rm -f "$f"; return 0; fi
  RERR=$( { grep -m1 -iE 'error|fail|unable|cannot|invalid|wrong' "$f" || true; tail -n 1 "$f"; } | awk '!seen[$0]++' | tr '\n' ' ')
  rm -f "$f"; return 1
}
RERR=""

# Is there a repository at the target, and does the passphrase open it? Sets REPO_STATE (ok | missing
# | password | unreachable) and RERR — called directly, never in $( ), or the reason is lost.
# The first contact is bounded: restic retries an unreachable backend for many minutes, and the
# setup page's test (and the doctor) must hear "does not answer" well before that.
REACH_TIMEOUT="${BB_REACH_TIMEOUT:-60}"
# A bucket that does not exist is retried by restic like a backend that does not answer — for as
# long as it is let — but its first retry line says which: the wait stops there (nobucket).
NO_BUCKET='bucket does not exist|NoSuchBucket'
repo_state() {
  local rc=0 f pid nobucket=0; f=$(mktemp)
  timeout "$REACH_TIMEOUT" restic "${restic_opts[@]}" cat config >/dev/null 2>"$f" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if grep -qiE "$NO_BUCKET" "$f"; then nobucket=1; kill "$pid" 2>/dev/null || true; break; fi
    sleep 0.5
  done
  wait "$pid" || rc=$?
  if [ "$rc" = 124 ]; then printf 'no answer within %s seconds\n' "$REACH_TIMEOUT" >> "$f"; fi
  RERR=$( { grep -m1 -iE 'error|fail|unable|cannot|invalid|wrong|no answer' "$f" || true; tail -n 1 "$f"; } | awk '!seen[$0]++' | tr '\n' ' ')
  if [ "$nobucket" = 0 ] && [ "$rc" != 0 ] && grep -qiE "$NO_BUCKET" "$f"; then nobucket=1; fi
  rm -f "$f"
  if [ "$nobucket" = 1 ]; then REPO_STATE=nobucket; return 0; fi
  case "$rc" in
    0) REPO_STATE=ok ;;
    10) REPO_STATE=missing ;;                             # restic: "repository does not exist"
    12) REPO_STATE=password ;;                            # restic: "wrong password"
    *) if [[ "$RERR" == *"wrong password"* ]]; then REPO_STATE=password; else REPO_STATE=unreachable; fi ;;
  esac
}
REPO_STATE=""
repo_problem() {
  case "$1" in
    password) echo "the backup passphrase does not open the repository at the target" ;;
    missing) echo "there is no backup repository at the target yet" ;;
    nobucket) echo "the bucket $(target_bucket) does not exist at the target — create it with your storage provider first (Black Branch never creates one), then try again" ;;
    *) echo "the backup target does not answer: ${RERR:-no reason given}" ;;
  esac
}

# The snapshot an argument names → its full id and time (sets SNAP_ID, SNAP_TIME).
resolve_snapshot() {
  local out
  [[ "$1" =~ $SNAP_RE ]] || fail "a snapshot is \"latest\" or its id"
  if ! out=$(r snapshots --json "$1" 2>/dev/null); then repo_state; fail "could not list the snapshots: $(repo_problem "$REPO_STATE")"; fi
  SNAP_ID=$(printf '%s' "$out" | node -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{const s=JSON.parse(t);const x=s[s.length-1];if(!x)process.exit(1);console.log(x.id+" "+x.time)})') \
    || fail "no snapshot \"$1\" at the target"
  SNAP_TIME="${SNAP_ID#* }"; SNAP_ID="${SNAP_ID%% *}"
}

psql_q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }
table_count() { # table_count <db> [psql options] — the database's own tables (not Postgres's)
  local db="$1"; shift
  psql_q "$@" -d "$db" -c "SELECT count(*) FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')"
}
sha() { sha256sum "$1" | cut -d' ' -f1; }

# ── backup ──────────────────────────────────────────────────────────────────────────────────
mode_backup() {
  local keep_d="${1:-7}" keep_w="${2:-4}" state db tables version dbs="" sep="" sk="null" mk="null" media=0 paths out sum id added files
  [[ "$keep_d" =~ ^[0-9]{1,3}$ && "$keep_w" =~ ^[0-9]{1,3}$ ]] || fail "retention must be whole numbers"
  repo_state; state="$REPO_STATE"
  case "$state" in
    ok) ;;
    missing) log "a new backup repository at the target"; r_err init --repository-version 2 >/dev/null || fail "could not create the repository: $RERR" ;;
    *) fail "$(repo_problem "$state")" ;;
  esac
  r unlock >/dev/null 2>&1 || true   # removes only locks whose process is gone

  find /bb/db -mindepth 1 -delete
  log "dumping the databases: ${DATABASES[*]}"
  for db in "${DATABASES[@]}"; do
    tables=$(table_count "$db") || fail "cannot read the $db database (is postgres running?)"
    pg_dump -d "$db" -Fc -f "/bb/db/$db.dump" || fail "pg_dump of $db failed"
    version=null
    if [ "$db" = stream ]; then
      version=$(psql_q -d stream -c "SELECT COALESCE(max(version), 0) FROM public.schema_migrations" 2>/dev/null || echo null)
    fi
    dbs+="$sep\"$db\":{\"tables\":$tables,\"bytes\":$(stat -c %s "/bb/db/$db.dump"),\"sha256\":\"$(sha "/bb/db/$db.dump")\",\"version\":${version:-null}}"
    sep=","
  done
  paths=(/bb/db /bb/home)
  if [ -s /bb/synapse/signing.key ]; then
    sk="{\"sha256\":\"$(sha /bb/synapse/signing.key)\",\"keyId\":\"$(awk 'NR==1 {print $1 ":" $2}' /bb/synapse/signing.key | tr -cd 'A-Za-z0-9_:-')\"}"
    paths+=(/bb/synapse/signing.key)
  else
    log "no homeserver signing key in synapse-data (not generated yet?)"
  fi
  if [ -d /bb/synapse/media_store ]; then
    media=$(find /bb/synapse/media_store -type f | wc -l)
    paths+=(/bb/synapse/media_store)
  fi
  [ -s /bb/home/matrix/mas-keys.yaml ] && mk="{\"sha256\":\"$(sha /bb/home/matrix/mas-keys.yaml)\"}"
  printf '{"v":1,"at":"%s","databases":{%s},"signingKey":%s,"masKeys":%s,"env":%s,"media":{"files":%s}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$dbs" "$sk" "$mk" "$([ -s /bb/home/.env ] && echo true || echo false)" "$media" > /bb/db/manifest.json

  log "writing the snapshot"
  out=$(mktemp)
  # Never the Cloudflare account's sign-in certificate an older installer left beside the tunnel's
  # own credentials: a restore does not need it, and a backup is the copy most likely to travel.
  if ! r backup --json --host "$HOST_TAG" --tag "$HOST_TAG" --exclude /bb/home/cloudflared/cert.pem "${paths[@]}" >"$out" 2>"$out.err"; then
    RERR=$(grep -v '^\s*$' "$out.err" | tail -n 2 | tr '\n' ' ')
    fail "the snapshot was not written: $RERR"
  fi
  sum=$(grep '"message_type":"summary"' "$out" | tail -1)
  rm -f "$out" "$out.err"
  find /bb/db -mindepth 1 -delete
  id=$(printf '%s' "$sum" | grep -oE '"snapshot_id":"[0-9a-f]+"' | cut -d'"' -f4)
  added=$(printf '%s' "$sum" | grep -oE '"data_added":[0-9]+' | cut -d: -f2)
  files=$(printf '%s' "$sum" | grep -oE '"total_files_processed":[0-9]+' | cut -d: -f2)
  [ -n "$id" ] || fail "restic reported no snapshot id"
  log "snapshot ${id:0:8}: ${files:-?} files, ${added:-0} bytes new"

  log "keeping $keep_d daily and $keep_w weekly snapshots"
  if ! r_err forget --host "$HOST_TAG" --tag "$HOST_TAG" --keep-daily "$keep_d" --keep-weekly "$keep_w" --prune >/dev/null; then
    result "{\"ok\":true,\"snapshot\":\"${id:0:8}\",\"added\":${added:-0},\"files\":${files:-0},\"media\":$media,\"pruned\":false,\"message\":$(jstr "the snapshot is safe, but old ones were not pruned: $RERR")}"
    return 0
  fi
  result "{\"ok\":true,\"snapshot\":\"${id:0:8}\",\"added\":${added:-0},\"files\":${files:-0},\"media\":$media,\"pruned\":true}"
}

mode_check() {
  local s; repo_state; s="$REPO_STATE"
  # The doctor's fixed field knows ok|missing|password|unreachable|refused: a bucket that is not there
  # is an endpoint that answers and holds no backups ("missing"); the message says which.
  if [ "$s" = ok ]; then result '{"ok":true,"repo":"ok"}'; else result "{\"ok\":false,\"repo\":\"${s/nobucket/missing}\",\"message\":$(jstr "$(repo_problem "$s")")}"; exit 1; fi
}

mode_snapshots() {
  local s; repo_state; s="$REPO_STATE"
  [ "$s" = ok ] || fail "$(repo_problem "$s")"
  r snapshots --compact
}

mode_key() {
  if [ ! -s /bb-ssh/id_ed25519 ]; then
    ssh-keygen -q -t ed25519 -N '' -C "blackbranch-backup" -f /bb-ssh/id_ed25519 >/dev/null || fail "could not make the SFTP key"
    log "made the SFTP key"
  fi
  cat /bb-ssh/id_ed25519.pub
}

# ── the scratch database (verify only): a Postgres of this container's own, on a unix socket ──
# In the container's own /tmp (gone with it): /scratch is root's alone, and Postgres runs as postgres.
PGBIN=/usr/lib/postgresql/18/bin
SCRATCH_PG=/tmp/bb-scratch-pg
scratch_pg_start() {
  mkdir -p "$SCRATCH_PG/data" "$SCRATCH_PG/run"
  chown -R postgres:postgres "$SCRATCH_PG"
  su postgres -s /bin/sh -c "$PGBIN/initdb -D $SCRATCH_PG/data -A trust -U postgres >/dev/null" || fail "could not start the scratch database (initdb)"
  su postgres -s /bin/sh -c "$PGBIN/pg_ctl -D $SCRATCH_PG/data -w -l $SCRATCH_PG/run/pg.log -o \"-c listen_addresses='' -k $SCRATCH_PG/run -c fsync=off\" start >/dev/null" \
    || fail "could not start the scratch database: $(tail -n 2 "$SCRATCH_PG/run/pg.log" 2>/dev/null | tr '\n' ' ')"
  SCRATCH_PG_UP=1
  # Never the live server: the socket is this container's, and no password exists here anyway.
  export PGHOST="$SCRATCH_PG/run" PGUSER=postgres
  unset PGPASSWORD
}
scratch_pg_stop() {
  if [ "${SCRATCH_PG_UP:-0}" = 1 ]; then su postgres -s /bin/sh -c "$PGBIN/pg_ctl -D $SCRATCH_PG/data -m immediate stop >/dev/null 2>&1" || true; fi
  SCRATCH_PG_UP=0
}
# The three roles and databases exactly as install/postgres/init-databases.sh makes them.
create_databases() { # drops any that exist first
  PGOPTIONS='-c client_min_messages=warning' psql_q -d postgres >/dev/null <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stream') THEN CREATE ROLE stream LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'synapse') THEN CREATE ROLE synapse LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mas') THEN CREATE ROLE mas LOGIN; END IF;
END $$;
DROP DATABASE IF EXISTS stream WITH (FORCE);
DROP DATABASE IF EXISTS synapse WITH (FORCE);
DROP DATABASE IF EXISTS mas WITH (FORCE);
CREATE DATABASE stream  OWNER stream;
CREATE DATABASE synapse OWNER synapse TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
CREATE DATABASE mas     OWNER mas;
REVOKE ALL ON DATABASE stream  FROM PUBLIC;
REVOKE ALL ON DATABASE synapse FROM PUBLIC;
REVOKE ALL ON DATABASE mas     FROM PUBLIC;
SQL
}

# The staged dumps against the manifest's hashes: a dump that changed after it was taken (or a
# truncated one) is refused before it is loaded anywhere.
dumps_match_manifest() { # dumps_match_manifest <dir> → prints a problem and returns 1
  local dir="$1" db want
  [ -s "$dir/manifest.json" ] || { echo "the snapshot holds no manifest"; return 1; }
  for db in "${DATABASES[@]}"; do
    [ -s "$dir/$db.dump" ] || { echo "the snapshot holds no $db dump"; return 1; }
    want=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((m.databases[process.argv[2]]||{}).sha256||"")' "$dir/manifest.json" "$db")
    [ "$(sha "$dir/$db.dump")" = "$want" ] || { echo "the $db dump does not match the hash it was written with"; return 1; }
  done
}

# The snapshot read back into <restored>: everything when the disk has room for it, otherwise all but
# the media store — and then a sample of the repository's stored data (packs of every kind, the
# media's among them) is read and checked instead: `restic check` alone reads only the structure, so
# a media store that did not fit was otherwise taken on trust while the record said "verify passed".
# Sets MEDIA (the files that came back, or null) and MEDIA_SAMPLE (the percent read instead, or null).
VERIFY_SAMPLE_PCT=10
verify_read_back() { # verify_read_back <restored dir> <scratch dir>
  local restored="$1" need avail
  MEDIA=null MEDIA_SAMPLE=null
  need=$(r stats --json --mode restore-size "$SNAP_ID" 2>/dev/null | grep -oE '"total_size":[0-9]+' | cut -d: -f2 || true)
  avail=$(( $(df -Pk "$2" | awk 'NR==2 {print $4}') * 1024 ))
  mkdir -p "$restored"
  if [ -n "$need" ] && [ "$need" -lt $(( avail * 8 / 10 )) ]; then
    r_err restore "$SNAP_ID" --target "$restored" >/dev/null || fail "the backup is damaged: the snapshot does not restore: $RERR"
    if [ -d "$restored/bb/synapse/media_store" ]; then MEDIA=$(find "$restored/bb/synapse/media_store" -type f | wc -l); fi
  else
    log "not enough free disk to read back the media store as well; restoring everything else"
    r_err restore "$SNAP_ID" --target "$restored" --exclude /bb/synapse/media_store >/dev/null \
      || fail "the backup is damaged: the snapshot does not restore: $RERR"
    log "reading back ${VERIFY_SAMPLE_PCT}% of the repository's stored data instead (nothing is written)"
    r_err check --read-data-subset="${VERIFY_SAMPLE_PCT}%" >/dev/null \
      || fail "the backup is damaged: a sample of its stored data did not read back: $RERR"
    MEDIA_SAMPLE=$VERIFY_SAMPLE_PCT
  fi
}

mode_verify() {
  local db tables="" loaded="" sep="" rc tok="" restored=/scratch/r out q
  trap scratch_pg_stop EXIT
  find /scratch -mindepth 1 -delete
  log "checking the repository's structure"
  r_err check >/dev/null || fail "the backup is damaged: restic check failed: $RERR"
  resolve_snapshot "$1"
  log "restoring snapshot ${SNAP_ID:0:8} (made $SNAP_TIME) into a scratch folder"
  verify_read_back "$restored" /scratch
  if ! out=$(dumps_match_manifest "$restored/bb/db"); then fail "the backup is damaged: $out"; fi

  log "loading the dumps into a scratch database"
  scratch_pg_start
  create_databases
  for db in "${DATABASES[@]}"; do
    rc=true
    pg_restore -d "$db" --exit-on-error "$restored/bb/db/$db.dump" 2>/scratch/restore-"$db".log || rc=false
    if [ "$rc" = true ]; then tables+="$sep\"$db\":$(table_count "$db")"; else tables+="$sep\"$db\":null"; fi
    loaded+="$sep\"$db\":$rc"; sep=","
  done
  # One stored token, as the site's doctor picks one (the first table that holds an encrypted one).
  for q in "SELECT mx_refresh_token FROM site.user_sessions WHERE mx_refresh_token LIKE 'v1:%' LIMIT 1" \
           "SELECT mx_refresh_token FROM site.users WHERE mx_refresh_token LIKE 'v1:%' LIMIT 1" \
           "SELECT refresh_token FROM site.accounts WHERE refresh_token LIKE 'v1:%' LIMIT 1"; do
    tok=$(psql_q -d stream -c "$q" 2>/dev/null || true)
    [ -n "$tok" ] && break
  done
  [[ "$tok" =~ ^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$ ]] || tok=""
  printf '{"snapshot":"%s","snapshotTime":"%s","tables":{%s},"loaded":{%s},"token":%s,"mediaFiles":%s,"mediaSample":%s,"chat":%s,"events":%s,"accounts":%s}\n' \
    "${SNAP_ID:0:8}" "$SNAP_TIME" "$tables" "$loaded" "$([ -n "$tok" ] && printf '"%s"' "$tok" || echo null)" "$MEDIA" "$MEDIA_SAMPLE" \
    "$(psql_q -d stream -c "SELECT CASE WHEN to_regclass('site.chat_messages') IS NULL THEN NULL ELSE (SELECT count(*) FROM site.chat_messages) END" 2>/dev/null || echo null)" \
    "$(psql_q -d synapse -c "SELECT CASE WHEN to_regclass('public.events') IS NULL THEN NULL ELSE (SELECT count(*) FROM events) END" 2>/dev/null || echo null)" \
    "$(psql_q -d mas -c "SELECT CASE WHEN to_regclass('public.users') IS NULL THEN NULL ELSE (SELECT count(*) FROM users) END" 2>/dev/null || echo null)" \
    > /scratch/facts.json
  scratch_pg_stop
  # The judge: hashes, tables, the token, the keys (install/backup/verify.mjs; prints BBRESULT).
  rc=0
  node /bb-backup/verify.mjs "$restored" /scratch/facts.json || rc=$?
  find /scratch -mindepth 1 -delete
  return "$rc"
}

# ── restore ─────────────────────────────────────────────────────────────────────────────────
mode_restore_stage() {
  local out
  find /scratch -mindepth 1 -delete
  resolve_snapshot "$1"
  log "reading snapshot ${SNAP_ID:0:8} (made $SNAP_TIME)"
  mkdir -p /scratch/r
  r_err restore "$SNAP_ID" --target /scratch/r --include /bb/db --include /bb/home >/dev/null \
    || fail "the snapshot does not restore: $RERR"
  if ! out=$(dumps_match_manifest /scratch/r/bb/db); then fail "the backup is damaged: $out"; fi
  result "{\"ok\":true,\"snapshot\":\"$SNAP_ID\",\"snapshotTime\":\"$SNAP_TIME\"}"
}

mode_restore_db() {
  local db out
  if ! out=$(dumps_match_manifest /scratch/r/bb/db); then fail "the backup is damaged: $out"; fi
  log "replacing the databases: ${DATABASES[*]}"
  create_databases
  for db in "${DATABASES[@]}"; do
    pg_restore -d "$db" --exit-on-error /scratch/r/bb/db/"$db".dump 2>/scratch/restore-"$db".log \
      || fail "pg_restore of $db failed: $(tail -n 2 /scratch/restore-"$db".log | tr '\n' ' ')"
    log "$db: $(table_count "$db") tables"
  done
  result '{"ok":true}'
}

mode_restore_media() {
  resolve_snapshot "$1"
  log "restoring Synapse's media store and signing key"
  r_err restore "$SNAP_ID" --target / --include /bb/synapse >/dev/null || fail "the media store did not restore: $RERR"
  find /scratch -mindepth 1 -delete
  result "{\"ok\":true,\"mediaFiles\":$( [ -d /bb/synapse/media_store ] && find /bb/synapse/media_store -type f | wc -l || echo 0)}"
}

# Sourced (a test): the functions only.
[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0
mode="${1:-}"; shift || true
case "$mode" in
  backup)        target_ready; mode_backup "$@" ;;
  check)         if ! out=$(node /bb-backup/target-check.mjs 2>&1); then result "{\"ok\":false,\"repo\":\"refused\",\"message\":$(jstr "the backup address is refused: $out")}"; exit 1; fi
                 target_ready; mode_check ;;
  snapshots)     target_ready; mode_snapshots ;;
  key)           mode_key ;;
  verify)        target_ready; mode_verify "${1:-latest}" ;;
  restore-stage) target_ready; mode_restore_stage "${1:?}" ;;
  restore-db)    mode_restore_db ;;
  restore-media) target_ready; mode_restore_media "${1:?}" ;;
  clean)         find /scratch -mindepth 1 -delete; result '{"ok":true}' ;;
  *) fail "unknown mode \"$mode\"" ;;
esac
