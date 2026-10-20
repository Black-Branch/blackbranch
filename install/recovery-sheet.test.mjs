// The recovery sheet: the backup passphrase reaches the setup page once, and never the site's
// environment. Run: node --test install/
//
// Why it may not live in web's environment: the site also decides WHERE root sends the backups
// (backup.* settings, re-read on every run; the `backup` and `backup-key` requests). A site that is
// compromised could point them at its own server — and with the passphrase, open them: .env, the
// signing keys, every database. So root hands the passphrase over only while the setup pages'
// recovery step is current, through its own results folder, and takes it back for good once setup
// moves on. Root keeps that "for good" itself: the site writes the setup state, so a site that
// rewinds its step to "recovery" must not get the sheet a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const read = (rel) => readFileSync(path.join(here, rel), "utf8");

test("web's environment holds no backup passphrase; the backup services alone read it", () => {
  const compose = read("compose.yaml");
  const start = compose.indexOf("\n  web:\n"), end = compose.indexOf("\n  caddy:\n");
  assert.ok(start > 0 && end > start, "the web service and the one after it were found");
  const web = compose.slice(start, end);
  // Vacuity anchor: the block is the WHOLE service (its environment and its last key are in it).
  assert.match(web, /\n {4}environment:\n/); assert.match(web, /\n {4}depends_on:\n {6}migrate: \{ condition: service_completed_successfully \}\n/);
  assert.match(web, /\n {6}BB_ENV_FILE: \$\{BB_HOME:-\/opt\/blackbranch\}\/\.env\n/, "the sheet still says where .env is");
  assert.doesNotMatch(web, /BACKUP_PASSPHRASE/);
  assert.equal((compose.match(/BACKUP_PASSPHRASE/g) ?? []).length, 2, "only backup and backup-verify/restore's RESTIC_PASSWORD read it");
  assert.equal((compose.match(/RESTIC_PASSWORD: \$\{BACKUP_PASSPHRASE:\?\}/g) ?? []).length, 2);
  const server = readFileSync(path.join(root, "web/app/lib/setup/setupServer.ts"), "utf8");
  assert.doesNotMatch(server, /process\.env\.BACKUP_PASSPHRASE/, "the setup pages read it from the host, never their environment");
  assert.match(server, /passphrase = await hostRecoveryPassphrase\(\)/);
  const site = readFileSync(path.join(root, "web/app/lib/hostRequests.ts"), "utf8");
  assert.match(site, /\| "recovery-sheet"/, "the site's HostVerb lacks recovery-sheet");
});

function sheetHome({ due = true } = {}) {
  const h = fakeHome();
  mkdirSync(path.join(h.home, "requests")); mkdirSync(path.join(h.home, "results"), { mode: 0o755 });
  // A new install: install.sh records, in root's own state, that this box's sheet is still to be shown.
  if (due) { mkdirSync(path.join(h.home, "state"), { recursive: true }); writeFileSync(path.join(h.home, "state/recovery-sheet-due"), ""); }
  const cfg = (k, v) => (v === null ? rmSync(path.join(h.fake, "cfg", k), { force: true }) : writeFileSync(path.join(h.fake, "cfg", k), `${v}\n`));
  // The query reads setup.state's step; the stand-in answers with the file's text.
  const step = (s) => cfg("setup.state", s);
  const ask = (verb = "recovery-sheet") => {
    writeFileSync(path.join(h.home, `requests/${verb}.req`), "");
    const r = h.run("process-requests");
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const sheet = path.join(h.home, "results/recovery-passphrase.json");
  const answer = () => JSON.parse(readFileSync(path.join(h.home, "results/recovery-sheet.json"), "utf8"));
  const pass = h.env().match(/^BACKUP_PASSPHRASE=(.*)$/m)[1];
  return { ...h, cfg, step, ask, sheet, answer, pass };
}

test("recovery-sheet: handed over while the recovery step is current, taken back for good once setup moves on", () => {
  const h = sheetHome();
  try {
    // No first admin yet: nothing to hand over.
    h.step("recovery");
    h.ask();
    assert.equal(existsSync(h.sheet), false);
    assert.equal(h.answer().ok, false); assert.match(h.answer().message, /not the recovery step|no first admin/);
    // The admin exists and the recovery step is current: the passphrase, in root's results folder.
    h.cfg("streamer.matrixId", "@casey:example.test");
    h.ask();
    assert.deepEqual(JSON.parse(readFileSync(h.sheet, "utf8")), { v: 1, passphrase: h.pass });
    assert.equal(statSync(h.sheet).mode & 0o007, 0, "never readable by every account on the host");
    assert.equal(h.answer().ok, true);
    assert.ok(!JSON.stringify(h.answer()).includes(h.pass), "the passphrase is not in the request's answer");
    assert.ok(!h.calls().includes(h.pass), "nor on docker's command line");
    // Asked again on the same step (a reload of the page): the same sheet.
    h.ask();
    assert.equal(JSON.parse(readFileSync(h.sheet, "utf8")).passphrase, h.pass);
    // Setup moves on. Any request's pass takes it back — not only this verb's.
    h.step("site");
    h.ask("update");
    assert.equal(existsSync(h.sheet), false, "taken back on the next pass of any request");
    // A site that rewinds its step to "recovery" gets nothing: root remembers it was shown.
    h.step("recovery");
    h.ask();
    assert.equal(existsSync(h.sheet), false);
    assert.equal(h.answer().ok, false); assert.match(h.answer().message, /shown once/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("recovery-sheet: never once setup is finished (an install from before this check included), and the last step takes it back", () => {
  let h = sheetHome();
  try {
    h.cfg("streamer.matrixId", "@casey:example.test"); h.step("recovery");
    h.cfg("setup.completedAt", "2026-10-10T00:00:00Z");
    h.ask();
    assert.equal(existsSync(h.sheet), false); assert.equal(h.answer().ok, false);
    // …and is remembered, so clearing completedAt in the database does not bring it back.
    h.cfg("setup.completedAt", null);
    h.ask();
    assert.equal(existsSync(h.sheet), false); assert.match(h.answer().message, /shown once/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  h = sheetHome();
  try {
    h.cfg("streamer.matrixId", "@casey:example.test"); h.step("recovery");
    h.ask();
    assert.ok(existsSync(h.sheet));
    // The setup pages' last step (apply-install) takes it back whatever the step says.
    writeFileSync(path.join(h.fake, "install.tsv"), "");
    h.ask("apply-install");
    assert.equal(existsSync(h.sheet), false);
    h.ask();
    assert.equal(existsSync(h.sheet), false);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("recovery-sheet: a box installed before the sheet existed never hands it over, whatever the database says", () => {
  // It finished setup before root kept any record. A compromised site clears setup.completedAt,
  // rewinds the step to "recovery" and asks: the database says the step is current, root's own
  // state says this install never had a sheet to show.
  const h = sheetHome({ due: false });
  try {
    h.cfg("streamer.matrixId", "@casey:example.test"); h.step("recovery");
    h.ask();
    assert.equal(existsSync(h.sheet), false, "the passphrase was handed to the site");
    assert.equal(h.answer().ok, false); assert.match(h.answer().message, /shown once/);
    assert.ok(existsSync(path.join(h.home, "state/recovery-sheet-shown")), "root's record is written from its own state");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("recovery-sheet: a passphrase .env cannot carry in one JSON line is not handed over", () => {
  const h = sheetHome();
  try {
    writeFileSync(path.join(h.home, ".env"), h.env().replace(/^BACKUP_PASSPHRASE=.*$/m, 'BACKUP_PASSPHRASE=a"b\\c'), { mode: 0o600 });
    h.cfg("streamer.matrixId", "@casey:example.test"); h.step("recovery");
    h.ask();
    assert.equal(existsSync(h.sheet), false);
    assert.equal(h.answer().ok, false); assert.match(h.answer().message, /BACKUP_PASSPHRASE in .*\.env/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("restore refuses a staged snapshot whose .env, MAS keys or tunnel credentials are links — before anything changes", () => {
  const h = fakeHome();
  try {
    const stage = path.join(h.home, "state/backup-scratch/r/bb/home");
    const target = path.join(h.home, "state/target");
    mkdirSync(path.join(h.home, "state"), { recursive: true });
    writeFileSync(target, "BK_TARGET=local\n");
    writeFileSync(path.join(h.fake, "run-out-check"), 'BBRESULT {"ok":true,"repo":"ok"}\n');
    writeFileSync(path.join(h.fake, "run-out-restore-stage"), 'BBRESULT {"ok":true,"snapshot":"abcd1234abcd1234","snapshotTime":"2026-10-12T00:00:00Z"}\n');
    const outside = path.join(h.home, "outside");
    mkdirSync(path.join(outside, "cf"), { recursive: true });
    writeFileSync(path.join(outside, "env"), h.env());
    writeFileSync(path.join(outside, "keys.yaml"), "x\n");
    for (const plant of [
      () => symlinkSync(path.join(outside, "env"), path.join(stage, ".env")),
      () => { writeFileSync(path.join(stage, ".env"), h.env()); mkdirSync(path.join(stage, "matrix")); symlinkSync(path.join(outside, "keys.yaml"), path.join(stage, "matrix/mas-keys.yaml")); },
      () => { writeFileSync(path.join(stage, ".env"), h.env()); symlinkSync(path.join(outside, "cf"), path.join(stage, "cloudflared")); },
      () => { writeFileSync(path.join(stage, ".env"), h.env()); mkdirSync(path.join(stage, "cloudflared")); symlinkSync(path.join(outside, "env"), path.join(stage, "cloudflared/creds.json")); },
    ]) {
      rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
      plant();
      const before = h.calls().length;
      const r = h.runWith({ BB_BACKUP_TARGET_FILE: target, FAKE_RUN_STATUS: "0", BB_RESTORE_NO_START: "1" }, "restore", "latest", "--yes");
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr, /holds a link .*nothing was changed/i);
      assert.doesNotMatch(h.calls().slice(before), /compose stop/, "refused before the site was stopped");
    }
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});
