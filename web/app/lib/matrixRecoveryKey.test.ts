// Rotating the recovery key keeps the key backup (encryption audit 2026-09-20, finding B): on a
// fake crypto backend, then the hook's wiring. The real-device run is
// matrixCryptoRepairs.hs.test.ts ("B: rotating the recovery key keeps the backup").
//
// The decision "is there a backup to keep?" is taken only on a POSITIVE server answer: a version,
// or M_NOT_FOUND. Anything else (an error, an unreadable state) stops the rotation with nothing
// changed — reading a failure as "no backup" would make a new one and delete every version.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  rotateRecoveryKeyKeepingBackup, readServerBackup, BackupKeyMissingError, BackupStateUnreadableError,
} from "./matrixRecoveryKey.ts";

type Check = { backupInfo: { version?: string }; trustInfo: { trusted: boolean; matchesDecryptionKey: boolean } } | null;
function fakeCrypto(check: Check | (() => Promise<Check>)) {
  const calls: Array<Record<string, unknown>> = [];
  const crypto = {
    checkKeyBackupAndEnable: typeof check === "function" ? check : async () => check,
    bootstrapSecretStorage: async (opts: Record<string, unknown>) => { calls.push(opts); },
  };
  return { crypto: crypto as never, calls };
}
const holding = (version: string, holds = true): Check => ({ backupInfo: { version }, trustInfo: { trusted: holds, matchesDecryptionKey: holds } });
const key = async () => ({ privateKey: new Uint8Array(32), keyInfo: {} }) as never;
const server = (v: { version: string } | null) => async () => v as never;

test("rotateRecoveryKey passes setupNewKeyBackup: false while the server holds a backup", async () => {
  const f = fakeCrypto(holding("7"));
  await rotateRecoveryKeyKeepingBackup(f.crypto, server({ version: "7" }), key);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.setupNewKeyBackup, false, "a new backup deletes every version on the server");
  assert.equal(f.calls[0]!.setupNewSecretStorage, true, "a new recovery key IS a new secret-storage key");
  assert.deepEqual(f.calls[1], { setupNewKeyBackup: false, setupNewSecretStorage: false });
});

test("a device without the backup's key is refused before anything is written", async () => {
  const f = fakeCrypto(holding("7", false));
  await assert.rejects(rotateRecoveryKeyKeepingBackup(f.crypto, server({ version: "7" }), key), (e) => e instanceof BackupKeyMissingError);
  assert.equal(f.calls.length, 0);
});

test("a server read that fails changes nothing: no new backup, an error", async () => {
  const f = fakeCrypto(null);
  const failing = async () => { throw new Error("502 Bad Gateway"); };
  await assert.rejects(rotateRecoveryKeyKeepingBackup(f.crypto, failing, key));
  assert.equal(f.calls.length, 0);
});

test("the SDK's own check reading null (its error case) while the server has a backup stops the rotation", async () => {
  for (const check of [null, holding("6")]) {
    const f = fakeCrypto(check);
    await assert.rejects(rotateRecoveryKeyKeepingBackup(f.crypto, server({ version: "7" }), key), (e) => e instanceof BackupStateUnreadableError);
    assert.equal(f.calls.length, 0, "nothing written while the device's view of the backup is unknown or stale");
  }
});

test("M_NOT_FOUND (no backup at all) → one is made; nothing existed to delete", async () => {
  const f = fakeCrypto(null);
  await rotateRecoveryKeyKeepingBackup(f.crypto, server(null), key);
  assert.equal(f.calls[0]!.setupNewKeyBackup, true);
});

test("readServerBackup: a version, null only for M_NOT_FOUND, and every other failure thrown", async () => {
  const http = (answer: () => Promise<unknown>) => ({ authedRequest: answer }) as never;
  assert.deepEqual(await readServerBackup(http(async () => ({ version: "7", algorithm: "m" }))), { version: "7", algorithm: "m" });
  assert.equal(await readServerBackup(http(async () => { throw Object.assign(new Error("nf"), { errcode: "M_NOT_FOUND" }); })), null);
  await assert.rejects(readServerBackup(http(async () => { throw Object.assign(new Error("x"), { errcode: "M_LIMIT_EXCEEDED" }); })));
  await assert.rejects(readServerBackup(http(async () => { throw new TypeError("fetch failed"); })));
  await assert.rejects(readServerBackup(http(async () => ({}))), "an answer without a version is not a positive answer");
});

test("wiring: the hook's rotateRecoveryKey goes through rotateRecoveryKeyKeepingBackup with the server read, and asks the SDK for nothing itself", () => {
  const src = stripComments(readFileSync(join(process.cwd(), "app/lib/useMatrixEncryptionSetup.ts"), "utf8"));
  const start = src.indexOf("async function rotateRecoveryKey(");
  const end = src.indexOf("async function generateAndSetupEncryption(");
  assert.ok(start > 0 && end > start, "rotateRecoveryKey precedes generateAndSetupEncryption");
  const body = src.slice(start, end);
  assert.match(body, /await rotateRecoveryKeyKeepingBackup\(crypto, \(\) => readServerBackup\(client\.http\),/);
  assert.match(body, /BackupStateUnreadableError/);
  assert.doesNotMatch(body, /bootstrapSecretStorage|resetKeyBackup|setupNewKeyBackup:\s*true/);
  // Vacuity anchor at the END of the file: a short read cannot pass the negative assertion above.
  assert.match(src.slice(-200), /copyKey,\s*\};\s*\}\s*$/);
});
