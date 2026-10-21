// Backups and `restore --verify`. Run: node --test install/
// What they hold: the verify judge's verdicts (healthy; a missing table; a token that will not
// decrypt; a missing signing key; …); the target reader resolves every backup.* key as stream-api
// would and decrypts the secret ones; the host refuses a target it cannot use, before anything
// runs, and records the failure for the doctor; the target's keys reach the container through its
// environment, never a command line; the timers are rendered from the quiet hour and time zone;
// the request verbs exist on both sides; and ONE real run with Docker — backup, verify, a real
// restore, then a damaged repository whose verify fails loudly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTANCE_KEYS, parseInstanceValue, checkBackupTarget } from "../config/instance-schema.mjs";
import { checkTarget, addressProblem, normalizeAddress } from "./backup/target-check.mjs";
import { judgeVerify, decryptToken, envValue } from "./backup/verify.mjs";
import { renderHome, fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");
const CI = process.env.CI === "true";
const has = (cmd, args = ["--version"]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const dockerCompose = has("docker", ["compose", "version"]);
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("vacuity anchors: the backup scripts end where they should", () => {
  assert.match(read("backup/run.sh"), /\n {2}\*\) fail "unknown mode \\"\$mode\\"" ;;\nesac\n$/);
  assert.match(read("backup/verify.mjs"), /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)\.href\) main\(process\.argv\.slice\(2\)\);\n$/);
  assert.match(read("backup/target-check.mjs"), /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)\.href\) main\(\);\n$/);
  assert.match(read("backup/target.cjs"), /main\(\)\.catch\(\(e\) => \{ process\.stderr\.write\([^\n]*\); process\.exit\(1\); \}\);\n$/);
});

// ── the verify judge ──────────────────────────────────────────────────────────────────────────
const KEY = randomBytes(32).toString("hex");
function encToken(plain, hex) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}
const SIGNING = `ed25519 a_TeSt ${randomBytes(32).toString("base64").replace(/=+$/, "")}\n`;
const MAS = "  keys:\n  - key: |\n      -----BEGIN EC PRIVATE KEY-----\n      x\n      -----END EC PRIVATE KEY-----\n";
const ENV = `TOKEN_ENC_KEY=${KEY}\nINSTANCE_MASTER_KEY=${"ab".repeat(32)}\nPOSTGRES_PASSWORD=${"cd".repeat(24)}\nBACKUP_PASSPHRASE="${"ef".repeat(24)}"\n`;
const healthy = () => ({
  manifest: {
    v: 1, databases: { stream: { tables: 150, sha256: "a" }, synapse: { tables: 190, sha256: "b" }, mas: { tables: 60, sha256: "c" } },
    signingKey: { sha256: sha(SIGNING), keyId: "ed25519:a_TeSt" }, masKeys: { sha256: sha(MAS) }, env: true, media: { files: 3 },
  },
  facts: {
    snapshot: "1a2b3c4d", snapshotTime: "2026-10-10T04:00:00Z", tables: { stream: 150, synapse: 190, mas: 60 },
    loaded: { stream: true, synapse: true, mas: true }, token: encToken("a refresh token", KEY), mediaFiles: 3, chat: 4, events: 40, accounts: 1,
  },
  env: ENV, signingKey: SIGNING, masKeys: MAS, at: "2026-10-10T05:00:00Z",
});
const verdict = (mutate = () => {}) => { const x = healthy(); mutate(x); return judgeVerify(x); };
const check = (v, id) => v.checks.find((c) => c.id === id);

test("verify: a healthy snapshot passes every check, and its result holds no secret", () => {
  const v = verdict();
  assert.equal(v.ok, true, JSON.stringify(v.checks));
  assert.deepEqual(v.checks.map((c) => c.id), ["dumps", "tables", "token", "signingKey", "masKeys", "env", "media"]);
  assert.deepEqual(v.failed, []);
  assert.equal(v.token, "ok"); assert.equal(v.media, 3); assert.equal(v.snapshot, "1a2b3c4d");
  assert.match(check(v, "tables").detail, /stream 150 · synapse 190 · mas 60/);
  const out = JSON.stringify(v);
  for (const secret of [KEY, "ab".repeat(32), "cd".repeat(24), "ef".repeat(24), healthy().facts.token, SIGNING.split(" ")[2].trim()]) {
    assert.ok(!out.includes(secret), "the verify result carries a secret");
  }
});

test("verify: a missing table, a token that will not decrypt, a missing signing key — each fails on its own", () => {
  const cases = [
    ["tables", (x) => { x.facts.tables.synapse = 189; }, /synapse: 189 tables, the backup recorded 190 \(a table is missing\)/],
    ["token", (x) => { x.env = x.env.replace(KEY, randomBytes(32).toString("hex")); }, /does not decrypt with the snapshot's TOKEN_ENC_KEY/],
    ["signingKey", (x) => { x.signingKey = null; }, /missing — the homeserver's identity cannot be recovered/],
    ["signingKey", (x) => { x.signingKey = `ed25519 a_TeSt ${randomBytes(32).toString("base64").replace(/=+$/, "")}\n`; }, /differs from the key that was backed up/],
    ["signingKey", (x) => { x.signingKey = "ed25519 a_TeSt c2hvcnQ\n"; }, /not 32 bytes/],
    ["dumps", (x) => { x.facts.loaded.mas = false; x.facts.tables.mas = null; }, /mas did not load/],
    ["masKeys", (x) => { x.masKeys = null; }, /missing/],
    ["env", (x) => { x.env = x.env.replace(/^POSTGRES_PASSWORD=.*$/m, ""); }, /lacks POSTGRES_PASSWORD/],
    ["media", (x) => { x.facts.mediaFiles = 2; }, /2 files, the backup recorded 3/],
  ];
  for (const [id, mutate, says] of cases) {
    const v = verdict(mutate);
    assert.equal(v.ok, false, `${id} did not fail`);
    assert.match(check(v, id).detail, says, id);
    assert.ok(v.failed.includes(id), id);
    // A failed dump also leaves its tables unread — that one may fail two checks; every other one alone.
    const others = v.failed.filter((x) => x !== id && !(id === "dumps" && x === "tables"));
    assert.deepEqual(others, [], `${id}'s fact failed other checks too`);
    assert.match(v.message, new RegExp(`^the backup would not bring the site back: .*${id} — `));
  }
});

test("verify: none stored yet is said, not red; media not read back for want of disk is said, not red", () => {
  const none = verdict((x) => { x.facts.token = null; });
  assert.equal(none.ok, true); assert.equal(none.token, "none"); assert.equal(check(none, "token").detail, "none stored yet");
  const nodisk = verdict((x) => { x.facts.mediaFiles = null; x.facts.mediaSample = 10; });
  assert.equal(nodisk.ok, true); assert.match(check(nodisk, "media").detail, /not read back .*10% of the stored data was read and checked instead/);
  assert.equal(nodisk.mediaChecked, false, "the record says the media store was not checked");
  assert.equal(nodisk.mediaSample, 10);
  assert.match(nodisk.message, /the media store was not read back/);
  // No sample either (a run.sh from before): said so, never "checked".
  const nosample = verdict((x) => { x.facts.mediaFiles = null; });
  assert.match(check(nosample, "media").detail, /not read back.*nothing of it was checked/);
  assert.equal(verdict().mediaChecked, true);
  assert.equal(verdict((x) => { x.manifest = null; }).ok, false, "a snapshot without a manifest cannot pass");
  assert.equal(decryptToken(healthy().facts.token, "zz"), false, "a malformed key decrypts nothing");
  assert.equal(envValue('A="q"\nB=r\n', "A"), "q");
});

test("verify on a box without room for the media store: the rest is restored, and a sample of the stored data is read back instead", () => {
  const work = mkdtempSync(path.join(tmpdir(), "bb-verify-"));
  try {
    mkdirSync(path.join(work, "bin")); mkdirSync(path.join(work, "scratch"));
    // A stand-in restic: a snapshot far larger than any disk; every call logged; check fails on demand.
    writeFileSync(path.join(work, "bin/restic"), `#!/usr/bin/env bash
echo "$*" >> "${work}/calls"
case "$1" in
  stats) echo '{"total_size":999999999999999999}' ;;
  check) [ -f "${work}/check-fails" ] && { echo "Fatal: pack 1a2b: ciphertext verification failed" >&2; exit 1; } ;;
esac
exit 0
`, { mode: 0o755 });
    const run = () => spawnSync("bash", ["-c",
      `. <(sed -n '/^log() {/p;/^target_host() {/p;/^jstr() {/,/^}/p;/^result() {/p;/^fail() {/,/^}/p;/^restic_opts=()/p;/^r() {/p;/^r_err() {/,/^}/p;/^RERR=/p;/^VERIFY_SAMPLE_PCT=/p;/^verify_read_back() {/,/^}/p' "$1") && SNAP_ID=abcd1234 && verify_read_back "$2/r" "$2/scratch" && echo "MEDIA=$MEDIA SAMPLE=$MEDIA_SAMPLE"`,
      "_", path.join(here, "backup/run.sh"), work], { encoding: "utf8", env: { ...process.env, PATH: `${path.join(work, "bin")}:/usr/bin:/bin` } });
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^MEDIA=null SAMPLE=10$/m);
    const calls = readFileSync(path.join(work, "calls"), "utf8");
    assert.match(calls, /^restore abcd1234 --target \S+\/r --exclude \/bb\/synapse\/media_store$/m);
    assert.match(calls, /^check --read-data-subset=10%$/m, "the stored data is read back, a sample of it");
    writeFileSync(path.join(work, "check-fails"), "");
    r = run();
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /BBRESULT \{"ok":false,"message":"the backup is damaged: a sample of its stored data did not read back: .*ciphertext verification failed/);
  } finally { rmSync(work, { recursive: true, force: true }); }
  // The facts carry it to the judge, and the host's line never says "media checked" when it was not.
  assert.match(read("backup/run.sh"), /"mediaFiles":%s,"mediaSample":%s,/);
  const bb = read("blackbranch");
  assert.match(bb, /if \[ "\$\(jfield "\$res" mediaChecked\)" = false \]; then\n {4}info "verify passed: [^\n]*tables, keys and token checked; media NOT read back \(no room on the disk\)/);
});

// ── where backups go: the target reader (runs in the stream-api image on a box) ────────────────
test("target.cjs resolves every backup.* key as stream-api would, decrypting the secret ones", () => {
  const keys = INSTANCE_KEYS.filter((e) => e.key.startsWith("backup."));
  assert.equal(keys.length, 7, "vacuity: the schema's backup keys");
  assert.deepEqual(keys.filter((e) => e.secret).map((e) => e.key).sort(), ["backup.s3.accessKeyId", "backup.s3.secretAccessKey"]);
  for (const e of keys.filter((k) => k.secret)) assert.deepEqual(e.packages, ["stream-api"], `${e.key}: the site never receives it`);
  const app = mkdtempSync(path.join(tmpdir(), "bb-app-"));
  try {
    for (const f of ["instance-config.js", "instanceSchema.generated.js"]) copyFileSync(path.join(root, "stream-api", f), path.join(app, f));
    const { encryptSecret } = createRequire(import.meta.url)(path.join(app, "instance-config.js"));
    const mk = randomBytes(32);
    const rows = {
      config: [{ key: "backup.target", value: "s3" }, { key: "backup.repository", value: "s3:https://s3.example.test/bucket/site" }, { key: "backup.keepDaily", value: 10 }],
      secrets: [{ key: "backup.s3.accessKeyId", ciphertext: encryptSecret("backup.s3.accessKeyId", "AKIDTEST", mk) },
        { key: "backup.s3.secretAccessKey", ciphertext: encryptSecret("backup.s3.secretAccessKey", "s3cret-value", mk) }],
    };
    mkdirSync(path.join(app, "node_modules/pg"), { recursive: true });
    writeFileSync(path.join(app, "node_modules/pg/index.js"), `const rows = ${JSON.stringify(rows)};
class Pool { async query(sql) { return { rows: sql.includes("instance_secrets") ? rows.secrets : rows.config }; } async end() {} }
module.exports = { Pool };\n`);
    const run = (env) => spawnSync(process.execPath, [path.join(here, "backup/target.cjs")], { encoding: "utf8", env: { PATH: process.env.PATH, BB_APP_DIR: app, ...env } });
    let r = run({ INSTANCE_MASTER_KEY: mk.toString("hex") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n").sort(), [
      "BK_KEEP_DAILY=10", "BK_KEEP_WEEKLY=", "BK_REPOSITORY=s3:https://s3.example.test/bucket/site", "BK_S3_ACCESS_KEY_ID=AKIDTEST",
      "BK_S3_REGION=", "BK_S3_SECRET_ACCESS_KEY=s3cret-value", "BK_TARGET=s3",
    ]);
    // env > database, as everywhere else — and the pair is judged as resolved: local with the stored
    // bucket address left behind is refused (a local backup takes no address).
    r = run({ INSTANCE_MASTER_KEY: mk.toString("hex"), BACKUP_TARGET: "sftp", BACKUP_REPOSITORY: "sftp:backup@192.168.1.20:/srv/b" });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^BK_TARGET=sftp$/m);
    r = run({ INSTANCE_MASTER_KEY: mk.toString("hex"), BACKUP_TARGET: "local" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /takes no address/);
    // A key that does not decrypt is an error, never an empty value.
    r = run({ INSTANCE_MASTER_KEY: randomBytes(32).toString("hex") });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /backup\.s3\.accessKeyId does not decrypt/); assert.equal(r.stdout, "");
    r = run({});
    assert.notEqual(r.status, 0); assert.match(r.stderr, /INSTANCE_MASTER_KEY is not set/);
    // A refused address — set in env here; a stored one is refused the same way — never reaches the host.
    r = run({ INSTANCE_MASTER_KEY: mk.toString("hex"), BACKUP_REPOSITORY: "rest:http://169.254.169.254/" });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /nothing else/); assert.equal(r.stdout, "");
  } finally { rmSync(app, { recursive: true, force: true }); }
});

// ── the host: target checks, secrets in the environment only, results, timers ────────────────
function backupHome() {
  const h = fakeHome();
  mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
  return h;
}
const target = (h, lines) => { const f = path.join(h.fake, "target.env"); writeFileSync(f, `${lines.join("\n")}\n`); return f; };
const last = (h) => JSON.parse(readFileSync(path.join(h.home, "results/backup-last.json"), "utf8"));

test("the host refuses a target it cannot use, before anything runs, and records the failure for the doctor", () => {
  const h = backupHome();
  try {
    for (const [lines, why] of [
      [["BK_TARGET=s3", "BK_REPOSITORY=s3:https://s3.example.test/b"], /access key id and secret key are not both set/],
      [["BK_TARGET=ftp"], /backup\.target must be local, s3 or sftp/],
      [["BK_TARGET=local", "BK_KEEP_DAILY=0"], /keepDaily must be 1–90/],
    ]) {
      const before = h.calls().length;
      const r = h.runWith({ BB_BACKUP_TARGET_FILE: target(h, lines) }, "backup");
      assert.notEqual(r.status, 0, lines.join(" "));
      assert.match(r.stderr, why);
      assert.doesNotMatch(h.calls().slice(before), /compose run/, "nothing ran");
      const l = last(h);
      assert.equal(l.ok, false); assert.equal(l.lastOkAt, null); assert.match(l.message, /not usable/);
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the target's keys reach the backup container through its environment, never a command line; results and lastOkAt", () => {
  const h = backupHome();
  try {
    const secret = "S3-SECRET-" + randomBytes(12).toString("hex");
    const file = target(h, ["BK_TARGET=s3", "BK_REPOSITORY=s3:https://s3.example.test/bucket", "BK_S3_ACCESS_KEY_ID=AKID", `BK_S3_SECRET_ACCESS_KEY=${secret}`]);
    writeFileSync(path.join(h.fake, "run-out-backup"), 'BBRESULT {"ok":true,"snapshot":"abcd1234","added":10,"files":3,"media":0,"pruned":true}\n');
    let r = h.runWith({ BB_BACKUP_TARGET_FILE: file, FAKE_RUN_STATUS: "0" }, "backup");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /backup abcd1234 written to the S3 bucket/);
    assert.ok(!h.calls().includes(secret), "a secret on docker's command line");
    assert.match(h.calls(), /compose run --rm --no-deps -T -e BK_TARGET -e BK_REPOSITORY -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION -e BB_REACH_TIMEOUT backup backup 7 4/);
    assert.doesNotMatch(h.calls(), /RESTIC_REPOSITORY/, "the host never hands restic an address: the container sets it after its check");
    assert.equal(readFileSync(path.join(h.fake, "env"), "utf8").trim(), `AWS_SECRET_ACCESS_KEY=${secret}`, "it did reach the environment");
    const ok1 = last(h);
    assert.equal(ok1.ok, true); assert.equal(ok1.snapshot, "abcd1234"); assert.equal(ok1.target, "s3"); assert.equal(ok1.lastOkAt, ok1.at);
    assert.equal(statSync(path.join(h.home, "results/backup-last.json")).mode & 0o777, 0o644);
    assert.ok(!readFileSync(path.join(h.home, "results/backup-last.json"), "utf8").includes("example.test"), "no target address in the result");
    // A failure after it keeps the last good time, and says why — with the address cut out.
    writeFileSync(path.join(h.fake, "run-out-backup"), 'BBRESULT {"ok":false,"message":"the backup target does not answer: dial tcp: <target>"}\n');
    r = h.runWith({ BB_BACKUP_TARGET_FILE: file, FAKE_RUN_STATUS: "1" }, "backup");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /BACKUP FAILED: the backup target does not answer/);
    const bad = last(h);
    assert.equal(bad.ok, false); assert.equal(bad.lastOkAt, ok1.lastOkAt);
    // The cache of the last target is the settings' only copy on disk: never written from a test hook,
    // and when written, root's alone (checked in the Docker run below for the real path).
    assert.equal(existsSync(path.join(h.home, "state/backup-target.env")), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("the request verbs: backup, backup-test (a backup, then a verify of it), backup-key — on both sides", () => {
  const h = backupHome();
  try {
    mkdirSync(path.join(h.home, "requests"));
    const file = target(h, ["BK_TARGET=local"]);
    writeFileSync(path.join(h.fake, "run-out-backup"), 'BBRESULT {"ok":true,"snapshot":"abcd1234","added":1,"files":1,"media":0,"pruned":true}\n');
    writeFileSync(path.join(h.fake, "run-out-verify"), `BBRESULT ${JSON.stringify(verdict())}\n`);
    writeFileSync(path.join(h.home, "requests/backup-test.req"), "");
    let r = h.runWith({ BB_BACKUP_TARGET_FILE: file, FAKE_RUN_STATUS: "0" }, "process-requests");
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(readFileSync(path.join(h.home, "results/backup-test.json"), "utf8"));
    assert.equal(res.ok, true, res.message); assert.equal(res.verb, "backup test");
    assert.match(res.message, /verify passed: snapshot 1a2b3c4d/);
    const v = JSON.parse(readFileSync(path.join(h.home, "results/backup-verify-last.json"), "utf8"));
    assert.equal(v.ok, true); assert.equal(v.snapshot, "1a2b3c4d");
    // A verify that fails turns the whole test red — the setup pages' Finish waits for both.
    writeFileSync(path.join(h.fake, "run-out-verify"), `BBRESULT ${JSON.stringify(verdict((x) => { x.signingKey = null; }))}\n`);
    writeFileSync(path.join(h.home, "requests/backup-test.req"), "");
    r = h.runWith({ BB_BACKUP_TARGET_FILE: file, FAKE_RUN_STATUS: "0" }, "process-requests");
    assert.equal(r.status, 0, r.stderr); // the request was handled; its answer says the test failed
    const res2 = JSON.parse(readFileSync(path.join(h.home, "results/backup-test.json"), "utf8"));
    assert.equal(res2.ok, false); assert.match(res2.message, /VERIFY FAILED: .*signingKey/);
    assert.equal(JSON.parse(readFileSync(path.join(h.home, "results/backup-verify-last.json"), "utf8")).ok, false);
    // The key: its public half is the result's message (what the setup page shows).
    writeFileSync(path.join(h.fake, "run-out-key"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey blackbranch-backup\n");
    writeFileSync(path.join(h.home, "requests/backup-key.req"), "");
    h.runWith({ FAKE_RUN_STATUS: "0" }, "process-requests");
    assert.match(readFileSync(path.join(h.home, "results/backup-key.json"), "utf8"), /"ok":true,.*"message":"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey blackbranch-backup"/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  const site = readFileSync(path.join(root, "web/app/lib/hostRequests.ts"), "utf8");
  for (const verb of ["backup", "backup-test", "backup-key"]) assert.match(site, new RegExp(`\\| "${verb}"`), `the site's HostVerb lacks ${verb}`);
});

test("restore refuses what it should before touching anything: no snapshot, a bad id, no terminal and no --yes", () => {
  const h = backupHome();
  try {
    for (const [args, why] of [[[], /usage: blackbranch restore/], [["../x"], /a snapshot is "latest" or its id/], [["latest"], /run it from a terminal, or add --yes/]]) {
      const r = spawnSync("setsid", ["bash", path.join(here, "blackbranch"), "restore", ...args],
        { encoding: "utf8", env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin` }, stdio: ["ignore", "pipe", "pipe"] });
      assert.notEqual(r.status, 0, args.join(" ")); assert.match(r.stderr, why);
    }
    assert.doesNotMatch(h.calls(), /compose (run|stop)/, "nothing ran");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("install verification pass: a new box whose .env was lost — the recovery sheet's passphrase, --from, the snapshot's domain and release", () => {
  const h = backupHome();
  const tt = (extra, ...args) => spawnSync("setsid", ["bash", path.join(here, "blackbranch"), ...args],
    { encoding: "utf8", env: { ...process.env, BB_HOME: h.home, FAKE: h.fake, PATH: `${path.join(h.fake, "bin")}:/usr/bin:/bin`, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const file = target(h, ["BK_TARGET=local"]);
    writeFileSync(path.join(h.fake, "run-out-check"), 'BBRESULT {"ok":false,"repo":"password","message":"the backup passphrase does not open the repository at the target"}\n');
    writeFileSync(path.join(h.fake, "run-out-check-good"), 'BBRESULT {"ok":true,"repo":"ok"}\n');
    const good = "RECOVERY-" + randomBytes(12).toString("hex");
    writeFileSync(path.join(h.fake, "good-pass"), good);
    // No terminal and no passphrase given: refused, nothing stopped.
    let r = tt({ BB_BACKUP_TARGET_FILE: file }, "restore", "latest", "--with-env", "--yes");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /the passphrase in \.env does not open these backups\. Run this in a terminal/);
    assert.doesNotMatch(h.calls(), /compose stop/);
    // A wrong one: refused too.
    r = tt({ BB_BACKUP_TARGET_FILE: file, BB_RECOVERY_PASSPHRASE: "wrong" }, "restore", "latest", "--with-env", "--yes");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /that passphrase does not open these backups either/);
    // The right one opens them: it reaches the container's environment, never a command line; then the
    // snapshot's .env names another domain → refused before anything live changes.
    const home = path.join(h.home, "state/backup-scratch/r/bb/home"); mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, ".env"), h.env().replace(/^BB_DOMAIN=.*$/m, "BB_DOMAIN=other.test"));
    writeFileSync(path.join(h.fake, "run-out-restore-stage"), 'BBRESULT {"ok":true,"snapshot":"abcd1234abcd1234","snapshotTime":"2026-10-12T00:00:00Z"}\n');
    r = tt({ BB_BACKUP_TARGET_FILE: file, BB_RECOVERY_PASSPHRASE: good, FAKE_RUN_STATUS: "0" }, "restore", "latest", "--with-env", "--yes");
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, /the recovery sheet's passphrase opens the backups/);
    assert.match(r.stderr, /the snapshot is of other\.test, and this box was installed for .*Nothing was changed/);
    assert.ok(!h.calls().includes(good), "the passphrase on docker's command line");
    assert.match(readFileSync(path.join(h.fake, "env"), "utf8"), new RegExp(`^BACKUP_PASSPHRASE=${good}$`, "m"));
    assert.doesNotMatch(h.calls(), /compose stop/);
    // --from: only a bucket or an SFTP address; a bucket's keys from BB_S3_* reach the environment.
    r = tt({}, "restore", "latest", "--verify", "--from", "rest:http://x/");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /--from takes a bucket .* or an SFTP address/);
    r = tt({}, "restore", "latest", "--verify", "--from", "s3:https://s3.example.test/b");
    assert.notEqual(r.status, 0); assert.match(r.stderr, /set BB_S3_ACCESS_KEY_ID and BB_S3_SECRET_ACCESS_KEY/);
    const sk = "S3-" + randomBytes(8).toString("hex");
    writeFileSync(path.join(h.fake, "run-out-check"), 'BBRESULT {"ok":true,"repo":"ok"}\n');
    r = tt({ BB_S3_ACCESS_KEY_ID: "AKID", BB_S3_SECRET_ACCESS_KEY: sk }, "restore", "latest", "--verify", "--from", "s3:https://s3.example.test/b");
    // Past the key check (no verify verdict is faked here, so the run itself ends in VERIFY FAILED).
    assert.doesNotMatch(r.stderr, /set BB_S3_ACCESS_KEY_ID/, r.stderr);
    assert.match(readFileSync(path.join(h.fake, "env"), "utf8"), new RegExp(`AWS_SECRET_ACCESS_KEY=${sk}`));
    assert.ok(!h.calls().includes(sk));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

// R1.6: a tunnel-mode move. A box installed with --moving has no tunnel of its own: the restore gives
// it the snapshot's, which then connects from here. A box that made its own tunnel keeps it — the
// snapshot's copied over it pointed cloudflared at a tunnel that no longer routes here.
test("restore and the tunnel: a box with none takes the snapshot's; a box with its own keeps it", () => {
  const OLD = "tunnel: 0ld00000-0000-0000-0000-000000000000\ncredentials-file: /etc/cloudflared/0ld00000-0000-0000-0000-000000000000.json\n";
  const OWN = "tunnel: 11111111-2222-3333-4444-555555555555\ncredentials-file: /etc/cloudflared/11111111-2222-3333-4444-555555555555.json\n";
  for (const own of [null, OWN]) {
    const h = backupHome();
    try {
      const file = target(h, ["BK_TARGET=local"]);
      writeFileSync(path.join(h.fake, "run-out-check"), 'BBRESULT {"ok":true,"repo":"ok"}\n');
      const staged = path.join(h.home, "state/backup-scratch/r/bb/home");
      mkdirSync(path.join(staged, "cloudflared"), { recursive: true });
      writeFileSync(path.join(staged, ".env"), h.env());
      writeFileSync(path.join(staged, "cloudflared/config.yml"), OLD);
      writeFileSync(path.join(staged, "cloudflared/0ld00000-0000-0000-0000-000000000000.json"), '{"old":1}\n');
      for (const [m, out] of [["restore-stage", '{"ok":true,"snapshot":"abcd1234abcd1234","snapshotTime":"2026-10-12T00:00:00Z"}'], ["restore-db", '{"ok":true}'], ["restore-media", '{"ok":true}']]) {
        writeFileSync(path.join(h.fake, `run-out-${m}`), `BBRESULT ${out}\n`);
      }
      mkdirSync(path.join(h.home, "cloudflared"), { recursive: true });
      if (own) writeFileSync(path.join(h.home, "cloudflared/config.yml"), own);
      const r = h.runWith({ BB_BACKUP_TARGET_FILE: file, FAKE_RUN_STATUS: "0", BB_RESTORE_NO_START: "1" }, "restore", "latest", "--yes");
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      const config = readFileSync(path.join(h.home, "cloudflared/config.yml"), "utf8");
      if (!own) {
        assert.equal(config, OLD, "the snapshot's tunnel, to connect from here");
        assert.ok(existsSync(path.join(h.home, "cloudflared/0ld00000-0000-0000-0000-000000000000.json")));
      } else {
        assert.equal(config, OWN, "this box's own tunnel is kept");
        assert.match(r.stdout, /kept this box's own tunnel — the snapshot's is another one/);
      }
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test("restore takes the snapshot's .env but keeps BB_RELEASE on the release in use (the images here are its)", () => {
  const bb = read("blackbranch");
  const restore = bb.slice(bb.indexOf("bb_restore() {"), bb.indexOf("backup_ssh_key() {"));
  assert.ok(restore.length > 500, "the restore function was found");
  assert.match(restore, /backup_lock\n {2}# [^\n]*\n {2}# [^\n]*\n {2}sync_release_tag\n/, "at its start (a half-done restore heals on a re-run)");
  assert.match(restore, /install -m 600 "\$home\/\.env" "\$ENV_FILE\.restore\.\$\$" \|\| ! replace_file "\$ENV_FILE\.restore\.\$\$" "\$ENV_FILE"; then\n[^\n]*\n {4}fi\n(?: {4}#[^\n]*\n)* {4}sync_release_tag\n/, "right after taking the snapshot's .env (by a rename, complete or not at all)");
  assert.match(bb, /sync_release_tag\(\) \{(?:(?!\n\}\n)[\s\S])*env_set BB_RELEASE "\$rel"/);
  assert.match(bb, /ensure_env_shape\(\) \{(?:(?!\n\}\n)[\s\S])*sync_release_tag/, "and `up` keeps it so too");
});

test("the timers: nightly backup at the quiet hour and weekly verify, in the site's time zone, rendered from the settings", () => {
  const h = backupHome();
  const sd = mkdtempSync(path.join(tmpdir(), "bb-systemd-"));
  try {
    const timer = (n) => readFileSync(path.join(sd, `blackbranch-${n}.timer`), "utf8");
    const render = (env = {}) => { const r = h.runWith({ BB_SYSTEMD_DIR: sd, ...env }, "render"); assert.equal(r.status, 0, r.stderr); return r; };
    // Unset: hour 4, UTC.
    render();
    assert.match(timer("backup"), /^OnCalendar=\*-\*-\* 04:00:00 UTC$/m);
    assert.match(timer("verify"), /^OnCalendar=Sun \*-\*-\* 04:30:00 UTC$/m);
    for (const n of ["backup", "verify"]) {
      assert.match(timer(n), /^Persistent=true$/m);
      assert.match(timer(n), new RegExp(`^Unit=blackbranch-${n}\\.service$`, "m"));
      assert.ok(existsSync(path.join(here, `systemd/blackbranch-${n}.service`)), `the ${n} service ships with the bundle`);
    }
    // The settings: the quiet hour and the time zone.
    writeFileSync(path.join(h.fake, "cfg/updates.quietHour"), "23\n");
    writeFileSync(path.join(h.fake, "cfg/site.timeZone"), "Europe/Berlin\n");
    const r = render();
    assert.match(timer("backup"), /^OnCalendar=\*-\*-\* 23:00:00 Europe\/Berlin$/m);
    assert.match(timer("verify"), /^OnCalendar=Sun \*-\*-\* 23:30:00 Europe\/Berlin$/m);
    assert.match(r.stdout, /timers: backup daily at 23:00, verify Sundays at 23:30, update check daily at 23:45 \(Europe\/Berlin\) — written\/written\/written/);
    // The database down: the values the last render saw.
    render({ FAKE_STATE: "exited" });
    assert.match(timer("backup"), /23:00:00 Europe\/Berlin/);
    // A zone systemd would not know (or anything that is not a zone name) falls back to UTC; a bad hour to 4.
    for (const tz of ["Mars/Olympus", "../../etc/passwd", "UTC; rm -rf"]) {
      writeFileSync(path.join(h.fake, "cfg/site.timeZone"), `${tz}\n`);
      render();
      assert.match(timer("backup"), /^OnCalendar=\*-\*-\* 23:00:00 UTC$/m, tz);
    }
    writeFileSync(path.join(h.fake, "cfg/updates.quietHour"), "24\n");
    render();
    assert.match(timer("backup"), /^OnCalendar=\*-\*-\* 04:00:00 UTC$/m);
    // Unprivileged and not pointed at a test folder: render leaves the system's timers alone.
    const r2 = h.run("render");
    assert.equal(r2.status, 0, r2.stderr); assert.doesNotMatch(r2.stdout, /timers:/);
  } finally { rmSync(h.home, { recursive: true, force: true }); rmSync(sd, { recursive: true, force: true }); }
  // The bundle's units reach the host through install-files (install.sh and every update).
  const units = read("blackbranch").match(/\nBUNDLE_UNITS=\(([^)]*)\)/)?.[1] ?? "";
  for (const n of ["backup", "verify", "update"]) assert.ok(units.split(/\s+/).includes(`blackbranch-${n}.service`), `install-files puts blackbranch-${n}.service in place`);
  assert.match(read("install.sh"), /blackbranch install-files\)/, "the installer uses install-files");
  assert.match(read("blackbranch"), /\n {2}backup_timers \|\| die "could not write the timers \(see above\)"\n\}\n\n# Synapse's data volume/, "render ends by rendering the timers");
  // Every release builds the backup image with the others — never only the first time one is missing.
  assert.match(read("blackbranch"), /local want targets=\(stream-api stream-ingest backup\)\n[\s\S]*?compose --profile backup build "\$\{targets\[@\]\}"\n/);
  assert.match(read("blackbranch"), /\nAPP_IMAGES=\(stream-api stream-ingest web backup\)\n/);
  assert.match(read("blackbranch"), /for i in "\$\{APP_IMAGES\[@\]\}"; do\n {4}if \[ "\$i" = web \] && ! web_from_source; then continue; fi\n {4}docker image inspect "blackbranch\/\$i:\$\(release_tag\)"/, "present = every app image of THIS release (the site's: the one its compose names)");
});

test("the Compose services: verify gets no database password and no live volume; restore alone writes Synapse's data", (t) => {
  if (!dockerCompose) { if (CI) assert.fail("docker compose is required in CI"); return t.skip("docker compose not installed"); }
  const dir = mkdtempSync(path.join(tmpdir(), "bb-compose-"));
  try {
    const cfg = JSON.parse(execFileSync("docker", ["compose", "-f", path.join(here, "compose.yaml"), "--project-directory", dir,
      "--env-file", path.join(here, ".env.example"), "--profile", "backup", "config", "--format", "json"],
    { encoding: "utf8", env: { ...process.env, COMPOSE_PROFILES: "", COMPOSE_FILE: "" } }));
    const vols = (s) => cfg.services[s].volumes.map((v) => `${v.source?.split("/").pop() ?? v.source}:${v.target}${v.read_only ? ":ro" : ""}`);
    const v = cfg.services["backup-verify"];
    assert.equal(v.environment.PGPASSWORD, undefined); assert.equal(v.environment.PGHOST, undefined);
    assert.deepEqual(Object.keys(v.environment).sort(), ["BB_CONFIG_DIR", "BB_SUBNET", "RESTIC_PASSWORD"]);
    for (const svc of ["backup", "backup-verify", "backup-restore"]) {
      assert.ok(vols(svc).includes("config:/config:ro"), `${svc}: the settings layer's rule, read-only`);
    }
    assert.ok(!vols("backup-verify").some((x) => /synapse|\.env|matrix|pg-data/.test(x)), vols("backup-verify").join(" "));
    assert.ok(vols("backup").includes("synapse-data:/bb/synapse:ro"), "backup reads Synapse's data read-only");
    assert.ok(vols("backup").includes(".env:/bb/home/.env:ro"));
    assert.ok(vols("backup-restore").includes("synapse-data:/bb/synapse"), "restore writes it");
    for (const s of ["backup", "backup-verify", "backup-restore"]) {
      assert.deepEqual(cfg.services[s].profiles, ["backup"], `${s} is never started by up`);
      assert.equal(cfg.services[s].ports, undefined);
      assert.equal(cfg.services[s].image, "blackbranch/backup:local");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── one real run (Docker): backup → verify → restore → a damaged repository fails loudly ────────
test("real run: backup, verify, a real restore brings the data and the signing key back, and a damaged snapshot fails verify loudly", { timeout: 600_000 }, (t) => {
  if (!dockerCompose) { if (CI) assert.fail("docker compose is required in CI"); return t.skip("docker compose not installed"); }
  const tag = randomBytes(3).toString("hex");
  const project = `bbtest${tag}`;
  const home = renderHome([
    `COMPOSE_PROJECT_NAME=${project}`, "COMPOSE_PROFILES=", "BB_TLS_MODE=internal",
    `BB_SUBNET=172.31.${parseInt(tag.slice(0, 2), 16)}.0/24`, `BB_CLOUDFLARED_IP=172.31.${parseInt(tag.slice(0, 2), 16)}.250`, `BB_CADDY_IP=172.31.${parseInt(tag.slice(0, 2), 16)}.249`,
  ].join("\n"));
  writeFileSync(path.join(home, ".env"), readFileSync(path.join(home, ".env"), "utf8")
    .replace(/^COMPOSE_FILE=.*$/m, `COMPOSE_FILE=${path.join(home, "compose.yaml")}`).replace(/^BB_HOME=.*$/m, `BB_HOME=${home}`), { mode: 0o600 });
  copyFileSync(path.join(here, "compose.yaml"), path.join(home, "compose.yaml"));
  symlinkSync(root, path.join(home, "release"));
  // Made here, as blackbranch would: a bind mount whose folder is missing is created by Docker, as root.
  for (const d of ["results", "state/backup-db", "state/backup-scratch", "cloudflared", "backups", "backup-ssh"]) mkdirSync(path.join(home, d), { recursive: true, mode: 0o755 });
  const env = { ...process.env, BB_HOME: home, BB_BACKUP_TARGET_FILE: path.join(home, "target.env"), BB_RESTORE_NO_START: "1" };
  writeFileSync(env.BB_BACKUP_TARGET_FILE, "BK_TARGET=local\n");
  const dc = (...a) => spawnSync("docker", ["compose", "--project-directory", home, ...a], { encoding: "utf8", env: { ...process.env, COMPOSE_FILE: path.join(home, "compose.yaml"), COMPOSE_PROFILES: "" } });
  const bb = (...a) => spawnSync("bash", [path.join(here, "blackbranch"), ...a], { encoding: "utf8", env });
  const psql = (db, sql) => {
    const r = dc("exec", "-T", "postgres", "psql", "-U", "postgres", "-d", db, "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql);
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  const inSynapse = (cmd) => { const r = dc("run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "backup-restore", "-c", cmd); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  try {
    // The image, as `up` would build it (BuildKit or not: the backup stage needs no context).
    const empty = mkdtempSync(path.join(tmpdir(), "bb-ctx-"));
    const b = spawnSync("docker", ["build", "-q", "--target", "backup", "-t", "blackbranch/backup:local", "-f", path.join(here, "Dockerfile"), empty], { encoding: "utf8" });
    rmSync(empty, { recursive: true, force: true });
    assert.equal(b.status, 0, b.stderr);
    let r = dc("up", "-d", "--wait", "postgres");
    assert.equal(r.status, 0, r.stderr);
    // A small install: a stored token (TOKEN_ENC_KEY), chat, a homeserver's events, an account, a signing key, media.
    const tokenKey = /^TOKEN_ENC_KEY=(.*)$/m.exec(readFileSync(path.join(home, ".env"), "utf8"))[1];
    psql("stream", `CREATE SCHEMA site; CREATE TABLE public.schema_migrations (version int); INSERT INTO public.schema_migrations VALUES (143);
      CREATE TABLE site.user_sessions (mx_refresh_token text); INSERT INTO site.user_sessions VALUES ('${encToken("refresh", tokenKey)}');
      CREATE TABLE site.chat_messages (body text); INSERT INTO site.chat_messages VALUES ('one'), ('two');
      ALTER SCHEMA site OWNER TO stream; ALTER TABLE site.chat_messages OWNER TO stream;`);
    psql("synapse", "CREATE TABLE events (id int); INSERT INTO events SELECT generate_series(1, 3); ALTER TABLE events OWNER TO synapse;");
    psql("mas", "CREATE TABLE users (id int); INSERT INTO users VALUES (1); ALTER TABLE users OWNER TO mas;");
    const signing = `ed25519 a_ReAl ${randomBytes(32).toString("base64").replace(/=+$/, "")}`;
    inSynapse(`mkdir -p /bb/synapse/media_store/local_content/ab && printf '%s\\n' '${signing}' > /bb/synapse/signing.key && echo picture > /bb/synapse/media_store/local_content/ab/cd && chown -R 991:991 /bb/synapse`);

    // A target that does not answer: restic would retry it for many minutes; the first contact is
    // bounded, so a bad bucket on the setup page is "does not answer" in seconds (here 5).
    // (192.0.2.1: TEST-NET-1 — an allowed address that nothing answers on.)
    writeFileSync(path.join(home, "unreachable.env"), "BK_TARGET=s3\nBK_REPOSITORY=s3:https://192.0.2.1/bucket\nBK_S3_ACCESS_KEY_ID=a\nBK_S3_SECRET_ACCESS_KEY=b\n");
    const t0 = Date.now();
    r = spawnSync("bash", [path.join(here, "blackbranch"), "backup"], { encoding: "utf8", env: { ...env, BB_BACKUP_TARGET_FILE: path.join(home, "unreachable.env"), BB_REACH_TIMEOUT: "5" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BACKUP FAILED: the backup target does not answer: .*no answer within 5 seconds/);
    assert.doesNotMatch(r.stderr, /192\.0\.2\.1/, "the target's address is cut out of the message");
    // A cloud-metadata address in the setting: refused inside the container before restic runs.
    writeFileSync(path.join(home, "metadata.env"), "BK_TARGET=s3\nBK_REPOSITORY=s3:https://169.254.169.254/latest\nBK_S3_ACCESS_KEY_ID=a\nBK_S3_SECRET_ACCESS_KEY=b\n");
    r = spawnSync("bash", [path.join(here, "blackbranch"), "backup"], { encoding: "utf8", env: { ...env, BB_BACKUP_TARGET_FILE: path.join(home, "metadata.env") } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BACKUP FAILED: the backup address is refused: 169\.254\.169\.254 is refused \(link-local — cloud metadata\)/);
    assert.ok(Date.now() - t0 < 60_000, `took ${Date.now() - t0} ms`);

    r = bb("backup");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const l = JSON.parse(readFileSync(path.join(home, "results/backup-last.json"), "utf8"));
    assert.equal(l.ok, true); assert.match(l.snapshot, /^[0-9a-f]{8}$/); assert.equal(l.target, "local");

    r = bb("restore", "latest", "--verify");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const v = JSON.parse(readFileSync(path.join(home, "results/backup-verify-last.json"), "utf8"));
    assert.equal(v.ok, true, v.message);
    assert.deepEqual(v.tables, { stream: 3, synapse: 1, mas: 1 });
    assert.equal(v.token, "ok"); assert.equal(v.media, 1); assert.deepEqual(v.rows, { chat: 2, events: 3, accounts: 1 });
    assert.equal(v.snapshot, l.snapshot);

    // Damage the live data, then a real restore.
    psql("stream", "INSERT INTO site.chat_messages VALUES ('after the backup'); DROP TABLE site.user_sessions;");
    psql("synapse", "DELETE FROM events;");
    inSynapse("echo 'ed25519 a_other AAAA' > /bb/synapse/signing.key; rm -rf /bb/synapse/media_store");
    r = bb("restore", "latest", "--yes");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restored snapshot [0-9a-f]{8} \(made /);
    r = dc("up", "-d", "--wait", "postgres"); assert.equal(r.status, 0, r.stderr);
    assert.equal(psql("stream", "SELECT string_agg(body, ',' ORDER BY body) FROM site.chat_messages"), "one,two");
    assert.equal(psql("stream", "SELECT count(*) FROM site.user_sessions"), "1");
    assert.equal(psql("synapse", "SELECT count(*) FROM events"), "3");
    assert.equal(psql("stream", "SELECT tableowner FROM pg_tables WHERE tablename = 'chat_messages'"), "stream", "owners kept");
    assert.equal(inSynapse("cat /bb/synapse/signing.key"), signing, "the signing key is the one backed up");
    assert.equal(inSynapse("stat -c %u /bb/synapse/signing.key; cat /bb/synapse/media_store/local_content/ab/cd"), "991\npicture");

    // A snapshot whose dump was cut short before it was stored: restic holds it intact, so only the
    // manifest's hash can tell — verify must refuse it before loading it anywhere.
    r = dc("run", "--rm", "--no-deps", "-T", "-e", "RESTIC_REPOSITORY=/backups/restic", "--entrypoint", "sh", "backup-restore", "-c",
      "set -e; restic restore latest --target /scratch/t --include /bb/db >/dev/null; truncate -s 4096 /scratch/t/bb/db/stream.dump; " +
      "mkdir -p /bb/db && cp -a /scratch/t/bb/db/. /bb/db/ && restic backup --host blackbranch --tag blackbranch /bb/db >/dev/null; rm -rf /scratch/t");
    assert.equal(r.status, 0, r.stderr);
    r = bb("restore", "latest", "--verify");
    assert.notEqual(r.status, 0, "a snapshot with a truncated dump verified");
    assert.match(r.stderr, /VERIFY FAILED: the backup is damaged: the stream dump does not match the hash it was written with/);

    // Damage the repository: every data pack gets bytes overwritten in its middle.
    const packs = execFileSync("docker", ["run", "--rm", "-v", `${path.join(home, "backups")}:/b`, "--entrypoint", "sh", "blackbranch/backup:local", "-c",
      "for f in $(find /b/restic/data -type f); do s=$(stat -c %s $f); dd if=/dev/urandom of=$f bs=1 count=64 seek=$((s / 2)) conv=notrunc 2>/dev/null; echo $f; done"], { encoding: "utf8" });
    assert.ok(packs.trim().split("\n").length >= 1, "vacuity: packs were damaged");
    r = bb("restore", l.snapshot, "--verify");
    assert.notEqual(r.status, 0, "a damaged backup verified");
    assert.match(r.stderr, /VERIFY FAILED: the backup is damaged/);
    const bad = JSON.parse(readFileSync(path.join(home, "results/backup-verify-last.json"), "utf8"));
    assert.equal(bad.ok, false); assert.match(bad.message, /damaged/);
  } finally {
    dc("down", "-v", "--remove-orphans");
    // Containers wrote as root into the scratch home; remove it with the same rights.
    spawnSync("docker", ["run", "--rm", "-v", `${home}:/h`, "--entrypoint", "sh", "pgvector/pgvector:pg18", "-c", "rm -rf /h/backups /h/backup-ssh /h/state /h/cloudflared"]);
    rmSync(home, { recursive: true, force: true });
  }
});

// ── where restic may connect: one rule, the settings layer's ────────────────────────────────────
const REFUSED = [
  "rest:http://169.254.169.254/latest/meta-data", "rclone:remote:bucket", "b2:bucket:path", "azure:container:/", "gs:bucket:/",
  "file:///etc", "/etc", "/opt/blackbranch", "local:/tmp/x", "s3:http://s3.example.test/bucket", "s3:https://s3.example.test",
  "s3:https://localhost/bucket", "s3:https://s3.example.test/bucket/../../x", "s3:https://user:pw@s3.example.test/bucket",
  "s3:https://999.1.1.1/bucket", "s3:https://s3.example.test:99999/bucket", "sftp:-oProxyCommand=touch@host.example:/b",
  "sftp:backup@host.example:relative", "sftp://backup@host.example:22/srv/$(id)", "sftp:backup@-oX.example:/b", "s3:https://s3.example.test/bucket?x=1",
];
const GOOD = ["s3:https://s3.us-west-004.backblazeb2.com/my-bucket", "s3:https://203.0.113.9:9000/bucket/site/backups",
  "sftp:backup@nas.home.arpa:/srv/backups", "sftp://backup@192.168.1.20:2222/srv/backups"];

test("the schema refuses every other restic backend and form, accepts the s3 and sftp forms — at write time", () => {
  const e = INSTANCE_KEYS.find((k) => k.key === "backup.repository");
  assert.equal(e.kind, "backupRepository", "the settings layer validates the address on every write");
  for (const v of REFUSED) {
    const r = parseInstanceValue(e, v);
    assert.equal(r.ok, false, v);
  }
  assert.match(parseInstanceValue(e, "rclone:remote:x").error, /nothing else \(no rest:, rclone:, b2:, azure:, gs:, file: or plain folders\)/);
  for (const v of GOOD) assert.deepEqual(parseInstanceValue(e, v), { ok: true, value: v }, v);
  // The target and its address together: local takes NO address; the kinds must match.
  assert.match(checkBackupTarget("local", "s3:https://s3.example.test/bucket").error, /takes no address/);
  assert.deepEqual(checkBackupTarget("local", ""), { ok: true, host: null });
  assert.match(checkBackupTarget("s3", "sftp:backup@nas.home.arpa:/b").error, /not an s3 address/);
  assert.match(checkBackupTarget("s3", "rest:http://169.254.169.254/").error, /nothing else/);
  assert.deepEqual(checkBackupTarget("sftp", GOOD[2]), { ok: true, host: "nas.home.arpa" });
  // One rule, three callers: the generated copies carry the same function, the page and the box call it.
  for (const f of ["../stream-api/instanceSchema.generated.js", "../web/app/lib/instanceSchema.generated.mjs"]) {
    assert.match(read(f), /function checkBackupTarget\(target, repository\) \{/, f);
  }
  assert.match(readFileSync(path.join(root, "web/app/lib/setup/setupBackup.ts"), "utf8"), /const t = checkBackupTarget\(target, form\.repository\);/);
  assert.match(read("backup/target.cjs"), /const t = checkBackupTarget\(val\['backup\.target'\] \|\| 'local', val\['backup\.repository'\]\);/);
  assert.match(read("backup/run.sh"), /\n {2}backup\) {8}target_ready; mode_backup/, "the box checks before a backup");
  for (const m of ["snapshots", "verify", "restore-stage", "restore-media"]) assert.match(read("backup/run.sh"), new RegExp(`\\n {2}${m}\\) +target_ready; `), m);
});

test("the box refuses loopback, link-local, the bundle's network and a rebinding name — private addresses stay allowed", async () => {
  const subnet = "172.29.83.0/24";
  const run = (repository, answers, target = "s3") => {
    let n = 0; const pins = [];
    const lookup = async () => { const a = answers[Math.min(n, answers.length - 1)]; n += 1; return a.map((address) => ({ address })); };
    return checkTarget({ target, repository, subnet, check: checkBackupTarget, lookup, pin: (h, ip) => pins.push([h, ip]) }).then((r) => ({ r, pins, lookups: n }));
  };
  for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "172.29.83.10", "172.17.0.1", "255.255.255.255"]) {
    const { r } = await run(`s3:https://${ip}/bucket`, [[]]);
    assert.equal(r.ok, false, ip); assert.match(r.error, /is refused \([^)]+\): loopback, link-local/, ip);
    assert.match(r.error, /private addresses \(10\.x, 172\.16–31\.x, 192\.168\.x\) are allowed — a NAS at home is fine/);
  }
  for (const a of ["::1", "fe80::1", "::ffff:127.0.0.1", "ff02::1", "::"]) assert.ok(addressProblem(a, subnet), a);
  // Names: every answer must be allowed; one loopback answer among public ones refuses the name.
  let { r } = await run("s3:https://s3.example.test/bucket", [["203.0.113.7", "127.0.0.1"]]);
  assert.equal(r.ok, false); assert.match(r.error, /s3\.example\.test resolves to 127\.0\.0\.1 is refused \(loopback\)/);
  ({ r } = await run("s3:https://s3.example.test/bucket", [["169.254.169.254"]]));
  assert.equal(r.ok, false);
  // The pin: the checked address is pinned, and a name that answers differently afterwards is refused.
  const ok = await run("s3:https://s3.example.test/bucket", [["203.0.113.7"], ["203.0.113.7"]]);
  assert.deepEqual(ok.r, { ok: true, repository: "s3:https://s3.example.test/bucket", host: "s3.example.test", address: "203.0.113.7" });
  assert.deepEqual(ok.pins, [["s3.example.test", "203.0.113.7"]]); assert.equal(ok.lookups, 2, "resolved again after the pin");
  const rebind = await run("s3:https://s3.example.test/bucket", [["203.0.113.7"], ["127.0.0.1"]]);
  assert.equal(rebind.r.ok, false); assert.match(rebind.r.error, /changed between the check and the connection/);
  // RFC1918 and the documentation ranges are allowed: a NAS at home is a real SFTP target.
  for (const repo of ["sftp:backup@192.168.1.20:/srv/b", "sftp://backup@10.0.0.5:2222/srv/b", "s3:https://172.16.5.5:9000/bucket"]) {
    const { r: rr } = await run(repo, [[]], repo.startsWith("s3") ? "s3" : "sftp");
    assert.equal(rr.ok, true, `${repo}: ${rr.error}`);
  }
  // Local: no lookup at all, no address.
  const loc = await run("", [[]], "local");
  assert.deepEqual(loc.r, { ok: true, repository: null, host: null, address: null }); assert.equal(loc.lookups, 0);
});

test("install verification pass: a bucket that does not exist is said plainly, at once — not retried to the bound as 'does not answer'", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "bb-nobucket-"));
  try {
    // restic 0.19.1 against a bucket that is not there (measured on a lab S3 gateway): it retries,
    // each line saying why, for as long as it is let; the box used to wait out its 60 s bound and
    // then report "the backup target does not answer".
    mkdirSync(path.join(tmp, "bin"));
    writeFileSync(path.join(tmp, "bin/restic"), `#!/bin/sh
echo 'Stat(<config/>) returned error, retrying after 1.029691497s: Stat: The specified bucket does not exist.' >&2
sleep 1
echo 'Stat(<config/>) returned error, retrying after 2.208041899s: Stat: The specified bucket does not exist.' >&2
exec sleep 60
`, { mode: 0o755 });
    const state = (repo) => {
      const t0 = Date.now();
      const r = spawnSync("bash", ["-c", `source "$1"; RESTIC_REPOSITORY="$2"; repo_state; printf '%s|%s\\n' "$REPO_STATE" "$(repo_problem "$REPO_STATE")"; mode_check`, "x",
        path.join(here, "backup/run.sh"), repo], { encoding: "utf8", env: { PATH: `${path.join(tmp, "bin")}:/usr/bin:/bin`, BB_REACH_TIMEOUT: "30" } });
      return { ...r, ms: Date.now() - t0 };
    };
    const r = state("s3:https://198.51.100.9/stream-backups/site");
    assert.ok(r.ms < 15_000, `said at once, not after the bound (${r.ms} ms)`);
    const [first, result] = r.stdout.split("\n");
    assert.equal(first, "nobucket|the bucket stream-backups does not exist at the target — create it with your storage provider first (Black Branch never creates one), then try again");
    // The doctor's fixed field: the endpoint answered and holds no backups (its row says so); the
    // message carries the cause, with the target's host cut out.
    const j = JSON.parse(result.replace(/^BBRESULT /, ""));
    assert.equal(j.repo, "missing"); assert.match(j.message, /bucket stream-backups does not exist/);
    assert.doesNotMatch(result, /198\.51\.100\.9/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  // Sourcing the script (as above) defines its functions and runs no mode.
  assert.match(read("backup/run.sh"), /\n# Sourced \(a test\): the functions only\.\n\[\[ "\$\{BASH_SOURCE\[0\]\}" == "\$0" \]\] \|\| return 0\nmode="\$\{1:-\}"; shift \|\| true\n/);
});

test("install verification pass: the backup address's description says where each SFTP form's folder is", () => {
  // Measured on a real SFTP server (item 3): sftp://user@host:port/folder is a folder INSIDE the
  // account's home; sftp:user@host:/folder is from the server's root. The description read as if
  // both were absolute.
  const d = INSTANCE_KEYS.find((k) => k.key === "backup.repository").description;
  assert.match(d, /sftp:<user>@<host>:\/<folder> \(from the server's root\)/);
  assert.match(d, /sftp:\/\/<user>@<host>:<port>\/<folder> \(a folder inside that account's home\)/);
});

test("target-check.mjs as the container runs it: refuses with plain words, pins what it allowed", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "bb-hosts-"));
  try {
    const hosts = path.join(tmp, "hosts"); writeFileSync(hosts, "");
    const run = (env) => spawnSync(process.execPath, [path.join(here, "backup/target-check.mjs")], { encoding: "utf8",
      env: { PATH: process.env.PATH, BB_HOSTS_FILE: hosts, BB_SUBNET: "172.29.83.0/24", ...env } });
    let r = run({ BK_TARGET: "s3", BK_REPOSITORY: "s3:https://127.0.0.1/bucket" });
    assert.equal(r.status, 1); assert.match(r.stdout, /127\.0\.0\.1 is refused \(loopback\)/);
    r = run({ BK_TARGET: "s3", BK_REPOSITORY: "rclone:x:y" });
    assert.equal(r.status, 1); assert.match(r.stdout, /nothing else/);
    r = run({ BK_TARGET: "local", BK_REPOSITORY: "/etc" });
    assert.equal(r.status, 1); assert.match(r.stdout, /takes no address/);
    r = run({ BK_TARGET: "sftp", BK_REPOSITORY: "sftp:backup@192.168.1.20:/srv/b" });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^BBCHECK \{"ok":true,"host":"192\.168\.1\.20","address":"192\.168\.1\.20"\}/);
    r = run({ BK_TARGET: "local" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(hosts, "utf8"), "", "an IP literal or local needs no pin");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("the blocklist's edges: embedded IPv4, ::, site-local, CGNAT, IMDS v6, names, the pin compare", async () => {
  const subnet = "172.29.83.0/24";
  // 1. IPv6 forms that carry a blocked IPv4 are judged as that IPv4.
  for (const [a, v4] of [["::ffff:7f00:1", "127.0.0.1"], ["::ffff:127.0.0.1", "127.0.0.1"], ["::127.0.0.1", "127.0.0.1"],
    ["64:ff9b::7f00:1", "127.0.0.1"], ["64:ff9b:1::a9fe:a9fe", "169.254.169.254"], ["2002:7f00:0001::", "127.0.0.1"], ["2002:a9fe:a9fe::1", "169.254.169.254"]]) {
    assert.deepEqual(normalizeAddress(a), { family: 4, address: v4 }, a);
    assert.match(addressProblem(a, subnet) ?? "", new RegExp(`\\(= ${v4.replace(/\./g, "\\.")}\\) is refused`), a);
  }
  assert.ok(addressProblem("::ffff:ac1d:530a", subnet), "a mapped address in the bundle's own network");
  // 2. Unspecified and the deprecated site-local range.
  for (const a of ["::", "0:0:0:0:0:0:0:0", "fec0::1", "feff::1"]) assert.ok(addressProblem(a, subnet), a);
  // 3. Cloud metadata outside 169.254: CGNAT (Alibaba 100.100.100.200; Tailscale) and AWS IMDS over IPv6.
  assert.match(addressProblem("100.100.100.200", subnet), /carrier-grade NAT .*Tailscale backup server is reached on its LAN address/);
  for (const a of ["100.64.0.1", "100.127.255.254", "fd00:ec2::254"]) assert.ok(addressProblem(a, subnet), a);
  // …while ULA, RFC1918, the CGNAT range's neighbours and NAT64 of a public address stay allowed.
  for (const a of ["fd12:3456::1", "fc00::5", "192.168.1.20", "10.0.0.7", "100.63.255.255", "100.128.0.1", "64:ff9b::808:808", "2001:db8::1"]) {
    assert.equal(addressProblem(a, subnet), null, a);
  }
  const run = (repository, answers) => {
    let n = 0; const pins = [];
    const lookup = async () => { const a = answers[Math.min(n, answers.length - 1)]; n += 1; return a.map((address) => ({ address })); };
    return checkTarget({ target: repository.startsWith("s3") ? "s3" : "sftp", repository, subnet, check: checkBackupTarget, lookup, pin: (h, ip) => pins.push([h, ip]) })
      .then((r) => ({ r, pins, lookups: n }));
  };
  // 4. Names that mean "this machine" or a metadata service: refused before any lookup.
  for (const name of ["localhost.localdomain", "backup.localhost", "metadata.google.internal", "a.b.localhost"]) {
    const { r, lookups } = await run(`s3:https://${name}/bucket`, [["203.0.113.7"]]);
    assert.equal(r.ok, false, name); assert.match(r.error, /names this machine or a cloud's metadata service/, name); assert.equal(lookups, 0, name);
  }
  // …and a name with no answer at all.
  assert.match((await run("s3:https://s3.example.test/bucket", [[]])).r.error, /does not resolve/);
  // 5. The pin is compared in canonical form and as a whole: the same address in another form passes…
  const same = await run("s3:https://s3.example.test/bucket", [["::ffff:203.0.113.7"], ["203.0.113.7"]]);
  assert.equal(same.r.ok, true, same.r.error); assert.deepEqual(same.pins, [["s3.example.test", "203.0.113.7"]]);
  // …a second answer beside the pinned one does not (not only the first element is compared)…
  const mixed = await run("s3:https://s3.example.test/bucket", [["203.0.113.7"], ["203.0.113.7", "127.0.0.1"]]);
  assert.equal(mixed.r.ok, false); assert.match(mixed.r.error, /changed between the check and the connection/);
  // …and a blocked address hidden in an embedded form in the FIRST answer is refused before the pin.
  const hidden = await run("s3:https://s3.example.test/bucket", [["203.0.113.7", "::ffff:7f00:1"]]);
  assert.equal(hidden.r.ok, false); assert.deepEqual(hidden.pins, []);
});
