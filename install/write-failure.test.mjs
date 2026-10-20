// A write that fails must never replace a file with less than it held. Run: node --test install/
//
// The failure these hold off: a full disk during the setup pages' last step turned .env — every
// bootstrap secret, which exists nowhere else — into 0 bytes. `set -e` was the only guard, and bash
// turns it off inside `if msg=$(cmd …)` (every request handler) and in `n=$(f) || die`, so the
// failed `awk … > tmp` went on to `mv tmp .env`.
//
// How a full disk is made without root: the file-size limit (`ulimit -S -f`, in KiB) with SIGXFSZ
// ignored, so a write past the limit fails with EFBIG exactly as one fails with ENOSPC — the
// writer gets an error and a short file, and carries on. The stand-in docker lifts the limit for
// itself (its call log is not the code under test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BB = path.join(here, "blackbranch");

// blackbranch with every file it writes limited to `kib` KiB.
function runLimited(h, kib, args, extraEnv = {}) {
  return spawnSync("bash", ["-c", `trap '' XFSZ; ulimit -S -f ${kib}; exec bash "$0" "$@"`, BB, ...args], {
    encoding: "utf8",
    env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin`, ...extraEnv },
  });
}
const leftovers = (dir) => readdirSync(dir).filter((f) => /^\.(env|render|result)\./.test(f));
const result = (h, name) => JSON.parse(readFileSync(path.join(h.home, "results", `${name}.json`), "utf8"));
// .env grown with a filler line to exactly `bytes` (a later write that adds a value then crosses the limit).
function padEnv(h, bytes) {
  const env = h.env();
  const filler = "BB_PAD=";
  const pad = bytes - Buffer.byteLength(env) - Buffer.byteLength(filler) - 1;
  assert.ok(pad > 0, `.env is already ${Buffer.byteLength(env)} bytes`);
  writeFileSync(path.join(h.home, ".env"), `${env}${filler}${"x".repeat(pad)}\n`, { mode: 0o600 });
  assert.equal(statSync(path.join(h.home, ".env")).size, bytes);
}

test("the disk fills during the setup pages' last step: .env is byte-for-byte as it was, and the result says what failed", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    writeFileSync(path.join(h.fake, "install.tsv"), "SITE_NAME\tMy Stream\nCURRENCY_NAME\tcoin\n");
    const before = h.env();
    assert.ok(Buffer.byteLength(before) > 2048, "the scratch .env is larger than the limit");
    writeFileSync(path.join(h.home, "requests/apply-install.req"), "");
    const r = runLimited(h, 2, ["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(h.env(), before, ".env changed on a full disk");
    const res = result(h, "apply-install");
    assert.equal(res.ok, false);
    assert.match(res.message, /could not .*\.env.*(disk|space)/i, res.message);
    assert.deepEqual(leftovers(h.home), [], "no half-written copy left beside .env");
    assert.doesNotMatch(h.calls(), /compose up/, "nothing restarted with a .env that was not written");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("apply-install: the copy kept for going back is written, then a value's write fails — .env is as it was", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    // .env 20 bytes under 4 KiB: its copy fits; the first value it gains does not.
    padEnv(h, 4096 - 20);
    writeFileSync(path.join(h.fake, "install.tsv"), "SITE_TAGLINE\tA tagline long enough to cross the limit\n");
    const before = h.env();
    writeFileSync(path.join(h.home, "requests/apply-install.req"), "");
    const r = runLimited(h, 4, ["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(h.env(), before, ".env changed by a failed write");
    const res = result(h, "apply-install");
    assert.equal(res.ok, false);
    assert.match(res.message, /could not write \.env/, res.message);
    assert.deepEqual(leftovers(h.home), []);
    assert.doesNotMatch(h.calls(), /compose (config|up)/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("set on a full disk: refused, .env as it was", () => {
  const h = fakeHome();
  try {
    const before = h.env();
    const r = runLimited(h, 2, ["set", "CURRENCY_NAME", "coin"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /could not write \.env/);
    assert.equal(h.env(), before);
    assert.deepEqual(leftovers(h.home), []);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("an .env migration's own record (BB_ENV_VERSION) fails to write: `up` stops, .env as it was", () => {
  const h = fakeHome();
  try {
    // The release in use is this checkout's: its migrations, its lib.sh. Every key 001 adds is
    // already there, so the migration itself writes nothing — only the version stamp after it does.
    mkdirSync(path.join(h.home, "release"));
    symlinkSync(here, path.join(h.home, "release/install"));
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^BB_ENV_VERSION=.*$/m, "BB_ENV_VERSION=0"), { mode: 0o600 });
    const before = h.env();
    const r = runLimited(h, 2, ["up"], { BB_BIN_DIR: path.join(h.home, "bin") });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /an \.env migration failed/);
    assert.equal(h.env(), before, ".env changed by a failed migration record");
    assert.deepEqual(leftovers(h.home), []);
    assert.doesNotMatch(h.calls(), /compose up -d postgres/, "`up` went on after the failure");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a request-driven render on a full disk replaces no rendered file", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    let r = h.run("render");
    assert.equal(r.status, 0, r.stderr);
    const files = ["caddy/Caddyfile", "synapse/homeserver.yaml", "synapse/log.config", "mas/config.yaml"];
    const before = Object.fromEntries(files.map((f) => [f, readFileSync(path.join(h.home, "rendered", f), "utf8")]));
    assert.ok(Buffer.byteLength(before["synapse/homeserver.yaml"]) > 1024);
    // A changed secret: every homeserver file renders differently now.
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^SYNAPSE_FORM_SECRET=.*$/m, `SYNAPSE_FORM_SECRET=${"ab".repeat(32)}`), { mode: 0o600 });
    writeFileSync(path.join(h.home, "requests/render.req"), "");
    r = runLimited(h, 1, ["process-requests"]);
    assert.equal(r.status, 0, r.stderr);
    for (const f of files) assert.equal(readFileSync(path.join(h.home, "rendered", f), "utf8"), before[f], `${f} replaced on a full disk`);
    const res = result(h, "render");
    assert.equal(res.ok, false);
    assert.match(res.message, /could not write .*rendered/, res.message);
    for (const d of ["rendered", "rendered/caddy", "rendered/synapse", "rendered/mas"]) assert.deepEqual(leftovers(path.join(h.home, d)), [], d);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("a state stamp on a full disk keeps what it held: the federation switch is not forgotten", () => {
  const h = fakeHome();
  try {
    // The switch is on, and the last render recorded it for the times the database is down.
    writeFileSync(path.join(h.fake, "cfg/matrix.federation"), "true");
    mkdirSync(path.join(h.home, "state"));
    writeFileSync(path.join(h.home, "state/federation"), "on\n");
    runLimited(h, 0, ["render"]);
    assert.equal(readFileSync(path.join(h.home, "state/federation"), "utf8"), "on\n", "the stamp was emptied by a write that failed");
    assert.deepEqual(readdirSync(path.join(h.home, "state")).filter((f) => f !== "federation"), [], "no half-written stamp left beside it");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("restore on a full disk: MAS's keys are as they were, never half the snapshot's", () => {
  const h = fakeHome();
  try {
    mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
    const tf = path.join(h.fake, "target.env"); writeFileSync(tf, "BK_TARGET=local\n");
    const ok = 'BBRESULT {"ok":true,"repo":"ok","snapshot":"abcd1234abcd1234","snapshotTime":"2026-10-12T00:00:00Z"}\n';
    for (const m of ["check", "restore-stage", "restore-db", "restore-media"]) writeFileSync(path.join(h.fake, `run-out-${m}`), ok);
    // The snapshot as the backup container staged it: this box's .env, and MAS's keys larger than the disk has room for.
    const staged = path.join(h.home, "state/backup-scratch/r/bb/home");
    mkdirSync(path.join(staged, "matrix"), { recursive: true });
    writeFileSync(path.join(staged, ".env"), h.env());
    writeFileSync(path.join(staged, "matrix/mas-keys.yaml"), `  keys:\n${"  - key: |\n      x\n".repeat(600)}`);
    const keys = path.join(h.home, "matrix/mas-keys.yaml");
    const before = readFileSync(keys, "utf8");
    const r = spawnSync("setsid", ["bash", "-c", `trap '' XFSZ; ulimit -S -f 4; exec bash "$0" "$@"`, BB, "restore", "latest", "--yes"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin`, BB_BACKUP_TARGET_FILE: tf,
        FAKE_RUN_STATUS: "0", BB_RESTORE_NO_START: "1" },
    });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, /Stopping the site/, `the restore got as far as the keys:\n${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(keys, "utf8"), before, "MAS's keys were replaced by a part of the snapshot's");
    assert.match(r.stderr, /could not write MAS's keys/);
    assert.deepEqual(readdirSync(path.join(h.home, "matrix")), ["mas-keys.yaml"], "no half-written copy left beside them");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the .env migrations' helpers stop on a failed write and leave the file as it was", () => {
  const h = fakeHome();
  try {
    const f = path.join(h.home, ".env");
    const before = h.env();
    for (const step of ['envm_add BB_NEW_KEY "a value"', "envm_drop SITE_NAME", "envm_rename SITE_NAME SITE_TITLE"]) {
      const r = spawnSync("bash", ["-c", `trap '' XFSZ; ulimit -S -f 2; . "$0"; ${step}; echo went-on`, path.join(here, "migrations/lib.sh")],
        { encoding: "utf8", env: { ...process.env, BB_ENV_FILE: f, PATH: "/usr/bin:/bin" } });
      assert.notEqual(r.status, 0, step);
      assert.doesNotMatch(r.stdout, /went-on/, step);
      assert.equal(h.env(), before, step);
      assert.deepEqual(leftovers(h.home), [], step);
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});
