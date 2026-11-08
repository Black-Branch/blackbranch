// Replacing the recovery key without touching the message history behind it.
//
// The recovery key unlocks secret storage (4S); the key BACKUP is a separate server object whose
// own key is one of the secrets 4S holds. A new recovery key only needs a new 4S key and the same
// secrets re-stored under it. Asking the SDK for a new backup as well (`setupNewKeyBackup: true`)
// deletes every backup version on the server and every message key stored in it: the rotating
// device re-uploads what it holds, so the loss shows only on the next device (encryption audit
// 2026-09-20, finding B).
//
// The flow follows SERVER state, and only a positive answer counts: a backup version, or
// M_NOT_FOUND. The SDK's own check answers null on ANY failure, which must never read as "no backup".
//
// Type-only SDK imports and relative imports: the homeserver suite runs this on real devices
// (matrixCryptoRepairs.hs.test.ts).
import type { CryptoApi, GeneratedSecretStorageKey, KeyBackupInfo } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { MatrixClient, Method } from "matrix-js-sdk";

/** Thrown when this device does not hold the key to the server's backup: a new 4S written now would
 *  not contain it, and the history would be unreachable with the new recovery key. */
export class BackupKeyMissingError extends Error {
  constructor() { super("BACKUP_KEY_MISSING"); }
}

/** Thrown when the backup's state could not be read for certain (the server or this device's view
 *  of it). Nothing has been changed. */
export class BackupStateUnreadableError extends Error {
  constructor() { super("BACKUP_STATE_UNREADABLE"); }
}

export const BACKUP_KEY_MISSING_MESSAGE =
  "This device doesn't hold the key to your message history yet, so a new recovery key would lock that history away. Enter your current recovery key first, or verify this device from one you're signed in on, then try again.";
export const BACKUP_STATE_UNREADABLE_MESSAGE =
  "Couldn't check your message backup with the server, so nothing was changed. Try again in a moment.";

/** The server's current key backup: its info, null ONLY when the server answers M_NOT_FOUND, and a
 *  throw for anything else (a network error, a rate limit, an answer without a version). */
export async function readServerBackup(http: Pick<MatrixClient["http"], "authedRequest">): Promise<KeyBackupInfo | null> {
  let info: KeyBackupInfo;
  try {
    info = await http.authedRequest<KeyBackupInfo>("GET" as Method, "/room_keys/version", undefined, undefined, { prefix: "/_matrix/client/v3" });
  } catch (e) {
    if ((e as { errcode?: string } | null)?.errcode === "M_NOT_FOUND") return null;
    throw e;
  }
  if (!info?.version) throw new BackupStateUnreadableError();
  return info;
}

/**
 * Write a new recovery key (via `createSecretStorageKey`) and keep the key backup and everything in
 * it. A backup is made only when the server says it has none, so nothing is ever deleted.
 */
export async function rotateRecoveryKeyKeepingBackup(
  crypto: CryptoApi,
  serverBackup: () => Promise<KeyBackupInfo | null>,
  createSecretStorageKey: () => Promise<GeneratedSecretStorageKey>,
): Promise<void> {
  const server = await serverBackup();
  if (server) {
    // The SDK saves the backup key into the new 4S from ITS view of the backup (refreshed here):
    // it must be the server's current version and this device must hold its key.
    const check = await crypto.checkKeyBackupAndEnable();
    if (!check || check.backupInfo.version !== server.version) throw new BackupStateUnreadableError();
    if (!check.trustInfo.matchesDecryptionKey) throw new BackupKeyMissingError();
  }
  await crypto.bootstrapSecretStorage({
    setupNewKeyBackup: server === null,
    setupNewSecretStorage: true,
    createSecretStorageKey,
  });
  // Again without a new key: re-encrypts the (unchanged) cross-signing keys under the new 4S key.
  await crypto.bootstrapSecretStorage({ setupNewKeyBackup: false, setupNewSecretStorage: false });
}
