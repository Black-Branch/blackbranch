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
  # The homeserver asked from inside its container (the token on stdin, never here): whoami fails
  # when fake/reader-invalid exists (a token MAS no longer knows); a join is logged and works.
  "compose exec -T synapse curl"*"/account/whoami"*) cat >/dev/null; [ -f "$FAKE/reader-invalid" ] && exit 22; exit 0 ;;
  "compose exec -T synapse curl"*"/join/"*) cat >> "$FAKE/join-stdin"; exit "\${FAKE_JOIN_STATUS:-0}" ;;
  "compose exec -T postgres psql"*)
    sql=$(cat)
    case "$sql" in *jsonb_each_text*) cat "$FAKE/install.tsv" 2>/dev/null; exit 0 ;; esac
    # The sign-in service's account count (the bootstrap's "does this account exist"): fake/mas-users.
    # Synapse has the account MAS made (the reader's first sign-in waits for it).
    case "$sql" in *"FROM users WHERE name ="*) echo 1; exit 0 ;; esac
    case "$sql" in *"FROM users WHERE username"*)
      for a in "$@"; do case "$a" in u=*) u="\${a#u=}" ;; esac; done
      cat "$FAKE/mas-users-$u" 2>/dev/null || cat "$FAKE/mas-users" 2>/dev/null; exit 0 ;; esac
    # Synapse's own tables (the community rooms' check): fake/rooms-state, "complete" or "missing".
    case "$sql" in *"FROM room_aliases"*) cat "$FAKE/rooms-state" 2>/dev/null; exit 0 ;; esac
    # The restart-only settings' last writes (status): fake/changed, "<key> <epoch seconds>" lines.
    case "$sql" in *"restart-pending"*) cat "$FAKE/changed" 2>/dev/null; exit 0 ;; esac
    for a in "$@"; do case "$a" in k=*) key="\${a#k=}" ;; esac; done
    cat "$FAKE/cfg/$key" 2>/dev/null; exit 0 ;;
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
  const runWith = (extraEnv, ...args) => spawnSync("bash", [path.join(here, "blackbranch"), ...args], {
    encoding: "utf8", env: { ...process.env, BB_HOME: home, FAKE: fake, PATH: `${path.join(fake, "bin")}:/usr/bin:/bin`, ...extraEnv },
  });
  const run = (...args) => runWith({}, ...args);
  const calls = () => { try { return readFileSync(path.join(fake, "calls"), "utf8"); } catch { return ""; } };
  return { home, fake, run, runWith, calls, env: () => readFileSync(path.join(home, ".env"), "utf8") };
}
