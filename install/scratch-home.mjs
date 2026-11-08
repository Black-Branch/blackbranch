// Shared by the install tests: a scratch install home for `blackbranch render`. Not a test file.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// A scratch install home for `blackbranch render`: .env.example made concrete for example.test
// (every placeholder secret a fresh hex value, as install.sh writes them), `extra` lines appended
// (a later line wins for that key), and a stand-in for MAS's signing keys so render needs no Docker.
export function renderHome(extra = "") {
  const home = mkdtempSync(path.join(tmpdir(), "bb-home-"));
  let env = readFileSync(path.join(here, ".env.example"), "utf8").replaceAll("example.com", "example.test")
    .replace(/=change-me$/gm, () => `=${randomBytes(32).toString("hex")}`);
  for (const line of extra.split("\n").filter(Boolean)) {
    const key = line.split("=")[0];
    env = env.match(new RegExp(`^${key}=`, "m")) ? env.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${env}${line}\n`;
  }
  writeFileSync(path.join(home, ".env"), env, { mode: 0o600 });
  // A box whose community service account's name was checked free at an earlier start (the render
  // registers it only then; render runs here without a database to ask). The check itself:
  // community-service.test.mjs.
  const lp = env.match(/^COMMUNITY_LOCALPART=(.*)$/m)?.[1] || "blackbranch";
  mkdirSync(path.join(home, "state"));
  writeFileSync(path.join(home, "state/community-name"), `free ${lp}\n`);
  mkdirSync(path.join(home, "matrix"), { mode: 0o700 });
  writeFileSync(path.join(home, "matrix/mas-keys.yaml"), "  keys:\n  - key: |\n      -----BEGIN EC PRIVATE KEY-----\n      test-only\n      -----END EC PRIVATE KEY-----\n", { mode: 0o600 });
  return home;
}
export const runRender = (home, ...args) => spawnSync("bash", [path.join(here, "blackbranch"), "render", ...args],
  { encoding: "utf8", env: { ...process.env, BB_HOME: home, PATH: "/usr/bin:/bin" } });

// A stand-in `docker` for the host commands that read the database through `compose exec`: each
// config key's value is a file under fake/cfg/, the setup pages' install values fake/install.tsv,
// every call is logged, and `compose run` prints fake/run-out[-<backup mode>] and exits with
// FAKE_RUN_STATUS (the target's keys it saw in its environment go to fake/env). FAKE_STATE=exited
// makes every container look stopped (the database down); FAKE_UNHEALTHY="web …" fails those
// services' health checks; fake/logs-<service> is what `docker logs` prints for one, and
// fake/restarts-<service> makes it a container that keeps restarting.
export function fakeHome(extra = "") {
  const home = renderHome(extra);
  const fake = path.join(home, "fake");
  mkdirSync(path.join(fake, "cfg"), { recursive: true });
  mkdirSync(path.join(fake, "bin"));
  writeFileSync(path.join(fake, "bin/docker"), `#!/usr/bin/env bash
# A test may limit the size of every file written (a full disk, install/write-failure.test.mjs);
# this stand-in is not what it tests, so its own log is never cut short.
ulimit -S -f unlimited 2>/dev/null || true
echo "$*" >> "$FAKE/calls"
# fake/fail-<n>: line 1 is a call's start ("compose up -d postgres"; ending in $, the whole call);
# that call fails, printing the rest of the file as Docker's own error text.
for f in "$FAKE"/fail-*; do
  [ -f "$f" ] || continue
  pat=$(head -n 1 "$f")
  case "$pat" in
    *'$') [ "$*" = "\${pat%'$'}" ] || continue ;;
    *) case "$*" in "$pat"*) ;; *) continue ;; esac ;;
  esac
  tail -n +2 "$f" >&2; exit 1
done
case "$*" in
  "inspect -f {{.State.Status}}"*) echo "\${FAKE_STATE:-running}" ;;
  "inspect -f {{if .State.Health}}"*) id="\${@: -1}"; case " \${FAKE_UNHEALTHY:-} " in *" \${id#id-} "*) echo unhealthy ;; *) echo healthy ;; esac ;;
  # A container that keeps stopping: fake/restarts-<service> holds its restart count, one more each read.
  "inspect -f {{.RestartCount}}"*) id="\${@: -1}"; f="$FAKE/restarts-\${id#id-}"
    if [ -f "$f" ]; then n=$(cat "$f"); echo "$n"; echo $(( n + 1 )) > "$f"; else echo 0; fi ;;
  "logs "*) id="\${@: -1}"; cat "$FAKE/logs-\${id#id-}" 2>/dev/null ;;
  # When a container last started: fake/started-<service>, else long ago.
  "inspect -f {{.State.StartedAt}}"*) id="\${@: -1}"; cat "$FAKE/started-\${id#id-}" 2>/dev/null || echo 2026-01-01T00:00:00Z ;;
  "compose ps -a -q "*) echo "id-\${@: -1}" ;;
  # A sign-in for one account: fake/mas-token-<account> when there is one, else fake/mas-token.
  "compose exec -T mas mas-cli manage issue-compatibility-token"*) cat "$FAKE/mas-token-$8" 2>/dev/null || cat "$FAKE/mas-token" 2>/dev/null; exit 0 ;;
  # The community service account's whoami (doctor, token-check): the body is fake/community-whoami,
  # the curl status FAKE_COMMUNITY_WHOAMI_STATUS; what arrived on stdin goes to fake/community-whoami-stdin.
  "compose exec -T synapse curl -sS -m 10 "*"/account/whoami"*) cat > "$FAKE/community-whoami-stdin"
    cat "$FAKE/community-whoami" 2>/dev/null; exit "\${FAKE_COMMUNITY_WHOAMI_STATUS:-0}" ;;
  # The homeserver asked from inside its container (the token on stdin, never here): whoami fails
  # when fake/reader-invalid exists (a token MAS no longer knows); a join is logged and works.
  "compose exec -T synapse curl"*"/account/whoami"*) cat >/dev/null; [ -f "$FAKE/reader-invalid" ] && exit 22; exit 0 ;;
  "compose exec -T synapse curl"*"/join/"*) cat >> "$FAKE/join-stdin"; exit "\${FAKE_JOIN_STATUS:-0}" ;;
  # The Discord bridge's own word for what it does (its entrypoint's state file): fake/ooye-state,
  # none by default (an older image without it).
  "compose exec -T ooye cat /tmp/bridge-state") cat "$FAKE/ooye-state" 2>/dev/null; exit 0 ;;
  # The bridge's links reader (install/ooye/links.js), run for real against fake/ooye.db with the
  # test's own node (FAKE_NODE: CI's node is not on this PATH).
  # The panel's link calls (install/ooye/link.js): every argument to fake/link-args, the answer
  # fake/link-out (else the bridge's 204), the status FAKE_LINK_STATUS.
  "compose exec -T ooye node --no-warnings /opt/blackbranch-ooye/link.js"*) shift 7; echo "$*" >> "$FAKE/link-args"
    if [ -f "$FAKE/link-out" ]; then cat "$FAKE/link-out"; else echo '{"ok":true,"status":204,"data":""}'; fi; exit "\${FAKE_LINK_STATUS:-0}" ;;
  # The panel's Discord reads (install/ooye/discord-read.js), run for real in fake/ (a registration.yaml
  # there) against the test's stand-in Discord (BB_DISCORD_API), OOYE's add-bot module from fake/ooye-root.
  "compose exec -T ooye node --no-warnings /opt/blackbranch-ooye/discord-read.js"*) shift 7
    cd "$FAKE" && BB_OOYE_ROOT="$FAKE/ooye-root" "$FAKE_NODE" --no-warnings "$FAKE_DISCORD_READ_JS" "$@"; exit $? ;;
  "compose exec -T ooye node --no-warnings /opt/blackbranch-ooye/links.js"*) shift 7
    cd "$FAKE" && BB_OOYE_DB="$FAKE/ooye.db" "$FAKE_NODE" --no-warnings "$FAKE_LINKS_JS" "$@"; exit $? ;;
  "compose exec -T postgres psql"*)
    sql=$(cat)
    case "$sql" in *jsonb_each_text*) cat "$FAKE/install.tsv" 2>/dev/null; exit 0 ;; esac
    # The sign-in providers MAS has enabled (the doctor): fake/mas-providers, one uuid a line.
    case "$sql" in *upstream_oauth_providers*) cat "$FAKE/mas-providers" 2>/dev/null; exit 0 ;; esac
    # The sign-in service's account count (the bootstrap's "does this account exist"): fake/mas-users.
    # Synapse has the account MAS made (the reader's first sign-in waits for it).
    case "$sql" in *"FROM users WHERE name ="*) echo 1; exit 0 ;; esac
    # The community service account's name check: whether a users table exists (t; fake/regclass to
    # change it), and a PERSON in Synapse under the name (no appservice_id: fake/synapse-person, else 0).
    # fake/psql-broken makes these queries fail as a broken database would: no answer, status 2.
    case "$sql" in *"to_regclass"*|*"appservice_id IS NULL"*) [ -f "$FAKE/psql-broken" ] && exit 2 ;; esac
    case "$sql" in *"to_regclass"*) cat "$FAKE/regclass" 2>/dev/null || echo t; exit 0 ;; esac
    case "$sql" in *"appservice_id IS NULL"*) cat "$FAKE/synapse-person" 2>/dev/null || echo 0; exit 0 ;; esac
    case "$sql" in *"FROM users WHERE username"*)
      for a in "$@"; do case "$a" in u=*) u="\${a#u=}" ;; esac; done
      cat "$FAKE/mas-users-$u" 2>/dev/null || cat "$FAKE/mas-users" 2>/dev/null || echo 0; exit 0 ;; esac
    # \`user admin\`: its SQL to fake/user-admin-sql; its one-word answer fake/user-admin-out.
    case "$sql" in *"'blackbranch user admin'"*) printf '%s' "$sql" > "$FAKE/user-admin-sql"; cat "$FAKE/user-admin-out" 2>/dev/null; exit 0 ;; esac
    # Synapse's own tables (the community rooms' check): fake/rooms-state, "complete" or "missing".
    case "$sql" in *"FROM room_aliases"*) cat "$FAKE/rooms-state" 2>/dev/null; exit 0 ;; esac
    # The Discord calls' rooms, from the site's rows: the hub (fake/hub-room) and the room marked for a
    # channel (fake/channel-room-<channel>, only while that row may be linked).
    case "$sql" in *"FROM site.community_spaces WHERE kind = 'hub'"*) cat "$FAKE/hub-room" 2>/dev/null; exit 0 ;; esac
    # The Discord server the community was imported from (the doctor's bot row): fake/import-guild.
    case "$sql" in *"FROM site.community_discord_import"*) cat "$FAKE/import-guild" 2>/dev/null; exit 0 ;; esac
    case "$sql" in *"WHERE discord_channel_id = :'c'"*)
      for a in "$@"; do case "$a" in c=*) ch="\${a#c=}" ;; esac; done
      cat "$FAKE/channel-room-$ch" 2>/dev/null; exit 0 ;; esac
    # The restart-only settings' last writes (status): fake/changed, "<key> <epoch seconds>" lines.
    case "$sql" in *"restart-pending"*) cat "$FAKE/changed" 2>/dev/null; exit 0 ;; esac
    for a in "$@"; do case "$a" in k=*) key="\${a#k=}" ;; esac; done
    cat "$FAKE/cfg/$key" 2>/dev/null; exit 0 ;;
  # The community service account's profile job: its stdin to fake/community-stdin, its answer
  # fake/community-out, its status FAKE_COMMUNITY_STATUS.
  "compose run "*"/bb-matrix/community-service.mjs"*) cat > "$FAKE/community-stdin"
    cat "$FAKE/community-out" 2>/dev/null; exit "\${FAKE_COMMUNITY_STATUS:-0}" ;;
  # The mail settings' reader (every render): fake/mail-out, none by default (no mail set).
  "compose run "*"/bb-matrix/mail.cjs"*) cat "$FAKE/mail-out" 2>/dev/null; exit 0 ;;
  # The sign-in providers' reader (every render): fake/signin-out, none by default (none switched on);
  # its status fake/signin-status (1: settings that cannot be read).
  "compose run "*"/bb-matrix/signin.cjs"*) cat "$FAKE/signin-out" 2>/dev/null; exit "$(cat "$FAKE/signin-status" 2>/dev/null || echo 0)" ;;
  # Each provider's discovery document, asked from inside stream-api (the doctor): fake/signin-discovery.
  "compose exec -T stream-api node -e "*"/.well-known/openid-configuration"*) cat "$FAKE/signin-discovery" 2>/dev/null; exit 0 ;;
  # The site's stored alert topics (the host's alerts with no BB_ALERT_NTFY_URL): fake/alert-topic-out,
  # none by default; its status FAKE_ALERT_TOPIC_STATUS.
  "compose run "*"/bb-alerts/topic.cjs"*) cat "$FAKE/alert-topic-out" 2>/dev/null; exit "\${FAKE_ALERT_TOPIC_STATUS:-0}" ;;
  # \`mail test\`: its answer fake/mail-send-out, its status FAKE_MAIL_SEND_STATUS.
  "compose run "*"/bb-matrix/mail-send.cjs"*) cat "$FAKE/mail-send-out" 2>/dev/null; exit "\${FAKE_MAIL_SEND_STATUS:-0}" ;;
  # The community reconciler's run: its stdin to fake/reconcile-stdin, its answer fake/reconcile-out,
  # its status FAKE_RECONCILE_STATUS. While fake/reconcile-hold exists the run keeps going (up to 30 s),
  # so a test can start a second one beside it; fake/reconcile-running says it has started.
  "compose run "*"/bb-matrix/reconcile.mjs"*) cat > "$FAKE/reconcile-stdin"; : > "$FAKE/reconcile-running"
    for _ in $(seq 300); do [ -f "$FAKE/reconcile-hold" ] || break; sleep 0.1; done
    cat "$FAKE/reconcile-out" 2>/dev/null; exit "\${FAKE_RECONCILE_STATUS:-0}" ;;
  "compose run "*)
    # What reached the container's environment rather than its command line (the backup target's keys).
    if [ -n "\${AWS_SECRET_ACCESS_KEY:-}" ]; then echo "AWS_SECRET_ACCESS_KEY=\$AWS_SECRET_ACCESS_KEY" >> "$FAKE/env"; fi
    # The recovery sheet's passphrase, when one was typed: through the environment too (Compose reads it).
    if [ -n "\${BACKUP_PASSPHRASE:-}" ]; then echo "BACKUP_PASSPHRASE=\$BACKUP_PASSPHRASE" >> "$FAKE/env"; fi
    # The backup image's mode (its last word among them) picks fake/run-out-<mode> when there is one;
    # check: run-out-check-good when the passphrase in use is fake/good-pass.
    m=""; for a in "$@"; do case "$a" in backup|verify|check|key|snapshots|restore-stage|restore-db|restore-media) m="$a" ;; esac; done
    if [ "$m" = check ] && [ -f "$FAKE/good-pass" ] && [ "\${BACKUP_PASSPHRASE:-}" = "$(cat "$FAKE/good-pass")" ]; then cat "$FAKE/run-out-check-good"; exit 0; fi
    if [ -f "$FAKE/run-out-$m" ]; then cat "$FAKE/run-out-$m"; else cat "$FAKE/run-out" 2>/dev/null; fi
    exit "\${FAKE_RUN_STATUS:-1}" ;;
esac
exit 0
`, { mode: 0o755 });
  // A stand-in `systemctl`, first on PATH like `docker`: the real one must never run from a test (as a
  // normal user it asks the desktop for a password: `up` starts a community run). Every call is
  // logged with the path it ran from; `is-enabled` answers from fake/enabled-<unit>, which enable
  // makes and disable removes.
  writeFileSync(path.join(fake, "bin/systemctl"), `#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE/calls"
echo "$0" >> "$FAKE/systemctl-ran-from"
unit="\${@: -1}"
case " $* " in
  *" is-enabled "*) [ -f "$FAKE/enabled-$unit" ] ;;
  *" enable "*) : > "$FAKE/enabled-$unit" ;;
  *" disable "*) rm -f "$FAKE/enabled-$unit" ;;
esac
`, { mode: 0o755 });
  const runWith = (extraEnv, ...args) => spawnSync("bash", [path.join(here, "blackbranch"), ...args], {
    encoding: "utf8", env: { ...process.env, BB_HOME: home, FAKE: fake, PATH: `${path.join(fake, "bin")}:/usr/bin:/bin`, ...extraEnv },
  });
  const run = (...args) => runWith({}, ...args);
  const calls = () => { try { return readFileSync(path.join(fake, "calls"), "utf8"); } catch { return ""; } };
  return { home, fake, run, runWith, calls, env: () => readFileSync(path.join(home, ".env"), "utf8") };
}
