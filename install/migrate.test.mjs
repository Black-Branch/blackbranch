// The migration runner (install/migrate.sh) against a real Postgres. Run: node --test install/
// CI runs it in the `install` job, where Docker exists; there a missing Docker is a FAILURE, never
// a skip (CI=true). Locally it is a visible skip.
//
// What it holds, with a small chain of its own (the real one is the baseline gate's):
//   • the baseline and its seeds are ONE transaction: schema.sql records every version in
//     schema_migrations, so a seed that failed after a committed schema was never tried again —
//     every later run said "up to date", and lockdown, slow mode and the timer failed silently;
//   • the seeds are applied on every run (each is ON CONFLICT DO NOTHING), so a box that lost one
//     that way heals;
//   • every newer migration is one transaction — as long as nothing follows its own COMMIT: one that
//     fails half-way leaves nothing of itself behind. A file's own COMMIT ENDS the runner's
//     transaction, and what follows it runs outside any; tools/check-migration-commit.mjs refuses
//     such a file, and the real run below shows why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitProblems } from "../tools/check-migration-commit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CI = process.env.CI === "true";
const docker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const skip = docker ? false : CI ? assert.fail("Docker is required in CI") : "Docker not available";
const IMAGE = readFileSync(path.join(here, "compose.yaml"), "utf8").match(/image: (pgvector\/pgvector:\S+)/)[1];

const SCHEMA = `CREATE TABLE public.schema_migrations (version integer PRIMARY KEY, note text);
INSERT INTO public.schema_migrations (version, note) VALUES (1, 'baseline'), (2, 'baseline');
CREATE TABLE public.lockdown (id integer PRIMARY KEY);
CREATE TABLE public.timer_state (id integer PRIMARY KEY);
`;
const SEED = `INSERT INTO public.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.timer_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

test("migrate.sh: the baseline and its seeds commit together, the seeds heal an older box, and a migration is one transaction", { skip, timeout: 180_000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bb-migrate-"));
  const name = `bb-migrate-test-${process.pid}`;
  const sh = (...a) => spawnSync("docker", a, { encoding: "utf8" });
  try {
    mkdirSync(path.join(dir, "baseline"));
    const put = (f, s) => writeFileSync(path.join(dir, f), s);
    put("baseline/schema.sql", SCHEMA);
    // The seed fails after its first row (a killed run, a full disk — any failure).
    put("baseline/seed.sql", `${SEED}SELECT 1 / 0;\n`);
    const up = sh("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=test-only",
      "-v", `${dir}:/m:ro`, "-v", `${path.join(here, "migrate.sh")}:/i/migrate.sh:ro`, IMAGE);
    assert.equal(up.status, 0, up.stderr);
    // TCP: the image's first-start server listens on its socket only, then restarts.
    const env = ["-e", "PGHOST=127.0.0.1", "-e", "PGUSER=postgres", "-e", "PGPASSWORD=test-only", "-e", "PGDATABASE=postgres", "-e", "MIGRATIONS_DIR=/m"];
    const migrate = () => sh("exec", ...env, name, "bash", "/i/migrate.sh");
    const q = (sql) => { const r = sh("exec", ...env, name, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", sql); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

    let r = migrate();
    assert.notEqual(r.status, 0, "a failed seed fails the run");
    assert.equal(q("SELECT to_regclass('public.schema_migrations') IS NULL"), "t", "nothing of the baseline is left: the next run starts it again");
    put("baseline/seed.sql", SEED);
    r = migrate();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /baseline applied: v2 \(2 versions\)/);
    assert.equal(q("SELECT count(*) FROM public.lockdown"), "1");

    // A box whose seed rows went missing (an older runner, a seed that failed after its schema committed).
    q("DELETE FROM public.lockdown; DELETE FROM public.timer_state;");
    r = migrate();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /up to date at v2/);
    assert.equal(q("SELECT count(*) FROM public.lockdown") + q("SELECT count(*) FROM public.timer_state"), "11", "the seeds are back");

    // A migration with no BEGIN/COMMIT of its own that fails half-way leaves nothing behind.
    put("migrate-v3.sql", "CREATE TABLE public.half (id integer);\nSELECT 1 / 0;\nINSERT INTO public.schema_migrations (version, note) VALUES (3, 'x') ON CONFLICT DO NOTHING;\n");
    r = migrate();
    assert.notEqual(r.status, 0);
    assert.equal(q("SELECT to_regclass('public.half') IS NULL"), "t", "the half-applied migration's table is gone");
    put("migrate-v3.sql", "CREATE TABLE public.half (id integer);\nINSERT INTO public.schema_migrations (version, note) VALUES (3, 'x') ON CONFLICT DO NOTHING;\n");
    r = migrate();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /applied 1 migration\(s\); now at v3/);
    // A file that carries its own BEGIN/COMMIT as its LAST statement still applies (psql only warns
    // about a BEGIN inside its transaction).
    put("migrate-v4.sql", "BEGIN;\nCREATE TABLE public.whole (id integer);\nINSERT INTO public.schema_migrations (version, note) VALUES (4, 'x') ON CONFLICT DO NOTHING;\nCOMMIT;\n");
    r = migrate();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(q("SELECT to_regclass('public.whole') IS NOT NULL"), "t");
    // Why nothing may follow that COMMIT: it ends the runner's transaction too. A statement after it
    // that fails leaves the part before it committed — the migration half applied, its row written.
    const after = "BEGIN;\nCREATE TABLE public.before_commit (id integer);\nINSERT INTO public.schema_migrations (version, note) VALUES (5, 'x') ON CONFLICT DO NOTHING;\nCOMMIT;\nCREATE TABLE public.after_commit (id integer);\nSELECT 1 / 0;\n";
    put("migrate-v5.sql", after);
    r = migrate();
    assert.notEqual(r.status, 0, "the failing statement fails the run");
    assert.equal(q("SELECT to_regclass('public.before_commit') IS NOT NULL"), "t", "the part before its COMMIT stayed: the runner's transaction did not cover the file");
    assert.equal(q("SELECT count(*) FROM public.schema_migrations WHERE version = 5"), "1", "and its row says it was applied");
    assert.notEqual(commitProblems(after).length, 0, "the static check refuses this file");
  } finally {
    sh("rm", "-f", name);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first start makes the three roles with the .env's passwords, read by psql from its environment", { skip, timeout: 180_000 }, () => {
  const name = `bb-initdb-test-${process.pid}`;
  const sh = (...a) => spawnSync("docker", a, { encoding: "utf8" });
  const pw = { stream: "stream-pw-0123456789", synapse: "synapse-pw-0123456789", mas: "mas-pw-0123456789" };
  // Over the container's own address: the image trusts 127.0.0.1 without a password, so a login
  // there would pass whatever the password was.
  const login = (role, p) => sh("exec", "-e", `PGPASSWORD=${p}`, "-e", `R=${role}`, name, "sh", "-c",
    'psql -XAtq -h "$(hostname -i | cut -d" " -f1)" -U "$R" -d "$R" -c "SELECT current_user"');
  try {
    const up = sh("run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=test-only",
      "-e", `STREAM_DB_PASSWORD=${pw.stream}`, "-e", `SYNAPSE_DB_PASSWORD=${pw.synapse}`, "-e", `MAS_DB_PASSWORD=${pw.mas}`,
      "-v", `${path.join(here, "postgres/init-databases.sh")}:/docker-entrypoint-initdb.d/10-databases.sh:ro`, IMAGE);
    assert.equal(up.status, 0, up.stderr);
    for (const [role, p] of Object.entries(pw)) {
      let r;
      for (let i = 0; i < 60; i++) {
        r = login(role, p);
        if (r.status === 0) break;
        spawnSync("sleep", ["1"]);
      }
      assert.equal(r.status, 0, `${role}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), role);
    }
    assert.notEqual(login("stream", "wrong").status, 0, "a wrong password is refused (the password is really set)");
  } finally { sh("rm", "-f", name); }
});

test("nothing follows a migration's own COMMIT: the check reads statements, not text, and every shipped file passes it", () => {
  // Refused: any statement after a transaction-ending one, however it is spelled.
  for (const sql of [
    "BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;\nCREATE TABLE b (id int);\n",
    "BEGIN;\nCREATE TABLE a (id int);\ncommit work;\nINSERT INTO public.schema_migrations (version) VALUES (9);\n",
    "BEGIN;\nCREATE TABLE a (id int);\nEND;\nDROP TABLE a;\n",
    "CREATE TABLE a (id int);\nCOMMIT;\nBEGIN;\nCREATE TABLE b (id int);\nCOMMIT;\n",
    "BEGIN; CREATE TABLE a (id int); COMMIT; /* a comment */ ALTER TABLE a ADD c int;",
  ]) assert.equal(commitProblems(sql).length, 1, sql);
  assert.match(commitProblems("BEGIN;\nSELECT 1;\nCOMMIT;\n\nSELECT 2;\n")[0], /^line 5: "SELECT 2" runs after the COMMIT on line 3/);
  // Allowed: COMMIT last (comments and blank lines after it), no COMMIT at all, and what only LOOKS
  // like one — a function body's END, a CASE's END, a string, a comment, a dollar-quoted body.
  for (const sql of [
    "BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;\n-- done\n\n/* trailing\n note */\n",
    "CREATE TABLE a (id int);\nINSERT INTO public.schema_migrations (version) VALUES (9) ON CONFLICT DO NOTHING;\n",
    "BEGIN;\nDO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END; $fn$;\nCOMMIT;\n",
    "BEGIN;\nUPDATE t SET v = CASE WHEN v IS NULL THEN 0 ELSE v END;\nCOMMIT;\n",
    "BEGIN;\nCOMMENT ON TABLE t IS 'COMMIT; DROP TABLE t;';\nCOMMIT;\n",
    "BEGIN;\n-- COMMIT; here is only prose\nSELECT 1;\nCOMMIT;\n",
    "BEGIN;\nSELECT E'it\\'s; COMMIT;';\nCOMMIT;\n",
  ]) assert.deepEqual(commitProblems(sql), [], sql);
  // Every migration in the repository, by the tool itself (what CI's install job runs here).
  const r = spawnSync(process.execPath, [path.join(here, "..", "tools/check-migration-commit.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^check-migration-commit: [1-9]\d* migrations, nothing after a COMMIT\n$/);
});

test("no migration the runner may apply uses what a transaction refuses", () => {
  // --single-transaction wraps every file: CREATE INDEX CONCURRENTLY, VACUUM, CREATE DATABASE and
  // ALTER SYSTEM cannot run inside one. Every file a release ships beside the baseline is checked.
  const root = path.join(here, "..");
  const first = Number(readFileSync(path.join(here, "release-copy.sh"), "utf8").match(/^FIRST_BASELINE_VERSION=(\d+)$/m)[1]);
  const files = spawnSync("bash", ["-c", 'ls "$1"/migrations/migrate-v*.sql', "_", root], { encoding: "utf8" }).stdout.trim().split("\n")
    .filter((f) => Number(f.match(/migrate-v(\d+)\.sql$/)[1]) > first);
  assert.ok(files.length > 0, "the release ships migrations newer than its first baseline");
  for (const f of files) {
    const sql = readFileSync(f, "utf8").replace(/--[^\n]*/g, "");
    assert.doesNotMatch(sql, /\b(CONCURRENTLY|VACUUM|CREATE\s+DATABASE|ALTER\s+SYSTEM)\b/i, path.basename(f));
  }
  assert.match(readFileSync(path.join(here, "migrate.sh"), "utf8"), /\n {2}apply --single-transaction -f "\$dir\/migrate-v\$v\.sql"\n/);
});
