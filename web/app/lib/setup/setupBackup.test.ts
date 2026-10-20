// Setup step 8's backups: the form's checks, and Finish only after a test backup that was made AND
// restored after the target was last saved. Run: node --test app/lib/setup/setupBackup.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBackupTarget, backupTestPassed, publicKeyOf } from "./setupBackup.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("the form: local needs nothing; a bucket and an SFTP server need their address; quotes, spaces and $ are refused", () => {
  const local = validateBackupTarget({ target: "local", repository: "s3:https://x/y", accessKeyId: "a" });
  assert.ok(local.ok); if (local.ok) assert.deepEqual(local.form, { target: "local", repository: "", region: "", accessKeyId: "", secretAccessKey: "" }, "local carries no address or key");
  assert.ok(validateBackupTarget({ target: "s3", repository: "s3:https://s3.example.test/bucket/site", region: "auto", accessKeyId: "AK", secretAccessKey: "SK" }).ok);
  assert.ok(validateBackupTarget({ target: "sftp", repository: "sftp:backup@192.0.2.7:/srv/b" }).ok);
  for (const [body, why] of [
    [{ target: "ftp" }, /choose where backups go/],
    [{ target: "s3", repository: "https://s3.example.test/b" }, /s3:https:\/\/<host>\[:port\]\/<bucket>/],
    [{ target: "s3", repository: "s3:https://s3.example.test" }, /s3:https/],
    [{ target: "sftp", repository: "sftp:host:/b" }, /sftp:<user>@<host>/],
    [{ target: "s3", repository: "s3:https://h/b", secretAccessKey: "a b" }, /secret key may not contain/],
    [{ target: "s3", repository: "s3:https://h.example/b$(id)" }, /nothing else/],
    [{ target: "s3", repository: "rest:http://169.254.169.254/latest" }, /nothing else \(no rest:, rclone:/],
    [{ target: "sftp", repository: "rclone:remote:x" }, /nothing else/],
    [{ target: "s3", repository: "s3:https://h.example/b", region: "eu west" }, /region may not contain/],
    [{ target: "s3", repository: `s3:https://h.example/${"b".repeat(300)}` }, /nothing else/],
  ] as const) {
    const v = validateBackupTarget(body as Record<string, unknown>);
    assert.equal(v.ok, false, JSON.stringify(body));
    if (!v.ok) assert.match(v.error, why);
  }
});

test("Finish waits for a test that passed after the target was last saved — an older pass does not count", () => {
  const asked = "2026-10-10T12:00:00Z";
  assert.equal(backupTestPassed(asked, { ok: true, at: "2026-10-10T12:03:00Z", message: "verify passed" }), true);
  assert.equal(backupTestPassed(asked, { ok: true, at: "2026-10-10T11:59:00Z", message: "verify passed" }), false, "from before the target was saved");
  assert.equal(backupTestPassed(asked, { ok: false, at: "2026-10-10T12:03:00Z", message: "VERIFY FAILED" }), false);
  assert.equal(backupTestPassed(undefined, { ok: true, at: "2026-10-10T12:03:00Z", message: "" }), false, "never asked");
  assert.equal(backupTestPassed(asked, null), false);
});

test("the SFTP key's public half is read from the host's answer, and nothing else is", () => {
  assert.equal(publicKeyOf({ ok: true, at: "x", message: "== Building… ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK+abc= blackbranch-backup" }), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK+abc= blackbranch-backup");
  assert.equal(publicKeyOf({ ok: false, at: "x", message: "ssh-ed25519 AAAA x" }), null);
  assert.equal(publicKeyOf({ ok: true, at: "x", message: "-----BEGIN OPENSSH PRIVATE KEY-----" }), null);
});

test("the routes: Finish refuses before the test passed; the test saves the target, then asks the host and records when", () => {
  const src = readFileSync(join(here, "setupServer.ts"), "utf8");
  const fin = src.slice(src.indexOf("export async function finishSetup("), src.indexOf("export async function finishStatus("));
  assert.match(fin, /if \(hostRequestsAvailable\(\) && !backupTestPassed\(readState\(\)\.backupAskedAt, await hostResult\("backup-test"\)\)\) \{\n {6}return fail\(409,/);
  assert.ok(fin.indexOf("backupTestPassed") < fin.indexOf('writeSetting("updates.quietHour"'), "the refusal comes before anything is saved");
  const start = src.slice(src.indexOf("export async function startBackupTest("), src.indexOf("export async function requestBackupKey("));
  assert.ok(start.indexOf('writeSetting("backup.target"') < start.indexOf('requestHost("backup-test")'), "saved first, then asked");
  assert.ok(start.indexOf('requestHost("backup-test")') < start.indexOf("backupAskedAt: r.requestedAt"), "the time recorded is the request's");
  assert.match(start, /if \(v\.form\.secretAccessKey\) await writeSetting\("backup\.s3\.secretAccessKey"/, "a blank secret keeps the saved one");
  // The page holds Finish until the test passed.
  const page = readFileSync(join(here, "../../features/setup/SetupWizard.tsx"), "utf8");
  assert.match(page, /disabled=\{!backupPassed && data\.hostRequests !== false\}/);
  assert.doesNotMatch(page, /coming in a later release<\/p>\n[^\n]*Backups/, "the old 'later' note is gone");
  assert.doesNotMatch(page, /Backups — coming in a later release/);
});
