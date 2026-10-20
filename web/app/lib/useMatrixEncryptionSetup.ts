import { useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { setPendingSecretStorageKey } from "@/app/lib/MatrixClientContext";
import { getOwnIdentity, refreshOwnIdentityFromServer, crossSigningResetUrl } from "@/app/lib/matrixCrypto";
import { fetchServerDeviceKeys, diagnoseVerifyFailure, verifyFailureMessage } from "@/app/lib/matrixDeviceKeys";
import { signOutEverything } from "@/app/lib/signOutEverything";
import { copyText } from "@/app/lib/clipboard";
import { getJson } from "@/app/lib/http";
import type { RestoreProgress, EncryptionFlow, Schedule } from "@/app/lib/matrixCrypto";

// The MSC4191 account URL for the approval-link fallback, from the site's own
// well-known. Error-path only; a miss degrades to the server-provided URL or
// a linkless message, never a failure of the reset itself.
async function accountUrlFromWellKnown(): Promise<string | null> {
  try {
    const wk = await getJson<{ "m.authentication"?: { account?: string } }>(
      "/.well-known/matrix/client");
    return wk?.["m.authentication"]?.account ?? null;
  } catch {
    return null;
  }
}

// Recovery-key restore + first-time setup / key rotation, extracted from
// useMatrixSettings. Reads the derived `flowState` and re-runs the caller's
// `checkCrossSigningStatus()` after each mutation so the traffic light + flow
// state stay in sync.
export function useMatrixEncryptionSetup({
  client,
  status,
  flowState,
  checkCrossSigningStatus,
  schedule,
}: {
  client: MatrixClient | null;
  status: string;
  flowState: EncryptionFlow;
  checkCrossSigningStatus: () => Promise<void>;
  schedule: Schedule;
}) {
  // ── Recovery key flow ───────────────────────────────────────────────────────

  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [recoveryKeyInput, setRecoveryKeyInput] = useState("");
  const [recoveryKeyVisible, setRecoveryKeyVisible] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgress>(null);
  const [restoreResult, setRestoreResult] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [verifyPending, setVerifyPending] = useState(false);
  // True once a restore's verification has been diagnosed as unrecoverable on
  // THIS device id (keys replaced under it, or a stale server-side signature):
  // the section then offers the one remedy that works — a fresh device.
  const [restoreNeedsFreshDevice, setRestoreNeedsFreshDevice] = useState(false);

  // ── Setup flow ──────────────────────────────────────────────────────────────

  const [showSetupFlow, setShowSetupFlow] = useState(false);
  const [setupStep, setSetupStep] = useState<null | "generating" | "show_key">(null);
  const [generatedKey, setGeneratedKey] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  // MSC4312 consent: non-null while "Start fresh" awaits the user's approval
  // on their MAS account page. The retry is just generateAndSetupEncryption(true)
  // again — approval armed the server, so the same upload now succeeds.
  const [resetApprovalUrl, setResetApprovalUrl] = useState<string | null>(null);

  function dismissResetApproval() {
    setResetApprovalUrl(null);
  }

  // ── Recovery key ────────────────────────────────────────────────────────────

  function dismissRecoveryKey() {
    setShowRecoveryKey(false);
    setRecoveryKeyInput("");
    setRecoveryKeyVisible(false);
    setRestoreError(null);
  }

  function startFreshFromKeyError() {
    setRestoreError(null);
    setShowRecoveryKey(false);
    setRecoveryKeyInput("");
    setRecoveryKeyVisible(false);
    setShowSetupFlow(true);
  }

  // The end of the 15 s wait for userTrustStatusChanged. Stopping the spinner
  // alone leaves "1 keys restored. Confirming verification…" followed by
  // "Device not verified" with no word on why. The why can be server-side —
  // the device's keys replaced under its live id while Synapse silently keeps
  // the old signature — so the diagnosis reads the server's copy and names it.
  //
  // But the local trust read is a SNAPSHOT: the OlmMachine only learns of a
  // signature added to this device while the tab was closed through a
  // device-list update, and this client's MemoryStore sync never carries one —
  // so a device the server had already signed would still read as untrusted
  // here, and the verdict below would call its own good signature "stale".
  // Before any verdict, ask the server once and read trust again.
  async function confirmVerification(crypto: NonNullable<ReturnType<MatrixClient["getCrypto"]>>, backupImported: number) {
    const ownIdentity = await getOwnIdentity(crypto);
    let trusted = ownIdentity != null
      ? await ownIdentity.trustsOurOwnDevice().catch(() => false)
      : false;
    const ownUserId = client?.getUserId();
    if (!trusted && ownUserId) {
      await refreshOwnIdentityFromServer(crypto, ownUserId);
      const refreshed = await getOwnIdentity(crypto);
      trusted = refreshed != null
        ? await refreshed.trustsOurOwnDevice().catch(() => false)
        : false;
    }
    setVerifyPending(false);
    if (trusted) {
      setRestoreResult(`Device verified — ${backupImported} room keys restored.`);
      await checkCrossSigningStatus();
      return;
    }
    let failure: ReturnType<typeof diagnoseVerifyFailure> = "not-signed";
    try {
      const userId = client?.getUserId();
      const deviceId = client?.getDeviceId();
      if (client && userId && deviceId) {
        const { CrossSigningKey } = await import("matrix-js-sdk/lib/crypto-api");
        const [server, local, selfSigningKey] = await Promise.all([
          fetchServerDeviceKeys(client, userId, deviceId),
          crypto.getOwnDeviceKeys(),
          crypto.getCrossSigningKeyId(CrossSigningKey.SelfSigning).catch(() => null),
        ]);
        failure = diagnoseVerifyFailure({ local, server, userId, deviceId, selfSigningKey });
        console.warn("[Matrix] verification did not land:", failure, {
          local: local.ed25519, server: server?.keys?.[`ed25519:${deviceId}`],
          serverSignatures: Object.keys(server?.signatures?.[userId] ?? {}), selfSigningKey,
        });
      }
    } catch (e) {
      console.warn("[Matrix] verification diagnosis failed:", e);
    }
    setRestoreResult(null);
    setRestoreError(verifyFailureMessage(failure));
    setRestoreNeedsFreshDevice(true);
  }

  async function applyRecoveryKey() {
    const input = recoveryKeyInput.trim();
    if (!input) return;
    if (!client || status !== "ready") { setRestoreError("Matrix not connected yet."); return; }
    const crypto = client.getCrypto?.();
    if (!crypto) { setRestoreError("Encryption not initialised."); return; }

    setRestoring(true);
    setRestoreNeedsFreshDevice(false);
    setRestoreError(null);
    setRestoreResult(null);
    setRestoreProgress(null);

    try {
      const { decodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key");
      let key: Uint8Array;
      try {
        key = decodeRecoveryKey(input);
      } catch {
        setRestoreError("Invalid recovery key. Check for typos and try again.");
        return;
      }

      // Validate against the 4S key record BEFORE doing anything — instant,
      // unambiguous feedback for a wrong key (same check Element does).
      const ss = client.secretStorage;
      const keyTuple = await ss?.getKey?.().catch(() => null);
      if (!keyTuple) {
        setRestoreError("No recovery key is set up on this account.");
        return;
      }
      const keyMatches = await ss.checkKey(key, keyTuple[1]).catch(() => false);
      if (!keyMatches) {
        setRestoreError("Recovery key doesn't match. Check the key and try again.");
        return;
      }

      setPendingSecretStorageKey(key);
      try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage().catch((e: unknown) => {
          // Backup key may legitimately be absent; cross-signing restore still works.
          console.warn("[Matrix] backup key load:", e);
        });

        let backupImported = 0;
        await crypto.restoreKeyBackup({
          progressCallback: (progress) => {
            const p = progress as Record<string, unknown>;
            if (typeof p.imported === "number" && typeof p.total === "number") {
              setRestoreProgress({ imported: p.imported, total: p.total });
            }
          },
        }).then((r) => { backupImported = r?.imported ?? 0; }).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("No backup")) throw e;
          console.warn("[Matrix] no key backup to restore (non-fatal)");
        });

        // Imports private cross-signing keys from 4S and signs this device.
        await crypto.bootstrapCrossSigning({ setupNewCrossSigning: false });

        // Belt-and-braces: when the OlmMachine already held the keys, the
        // bootstrap import path (which signs the device) is skipped.
        const clientDeviceId = client.getDeviceId();
        if (clientDeviceId) {
          await crypto.crossSignDevice(clientDeviceId).catch((e: unknown) => {
            console.warn("[Matrix] crossSignDevice:", e);
          });
        }

        await checkCrossSigningStatus();
        const ownIdentity = await getOwnIdentity(crypto);
        const trusted = ownIdentity != null
          ? await ownIdentity.trustsOurOwnDevice().catch(() => false)
          : false;
        if (trusted) {
          setRestoreResult(`Device verified — ${backupImported} room keys restored.`);
        } else {
          // Signature upload may still be in flight; userTrustStatusChanged
          // re-runs checkCrossSigningStatus when it lands.
          setRestoreResult(`${backupImported > 0 ? `${backupImported} keys restored. ` : ""}Confirming verification…`);
          setVerifyPending(true);
          schedule(() => { void confirmVerification(crypto, backupImported); }, 15_000);
        }
      } finally {
        setPendingSecretStorageKey(null);
      }

      setShowRecoveryKey(false);
      setRecoveryKeyInput("");
      setRecoveryKeyVisible(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("doesn't match the public key that was uploaded")) {
        setRestoreError("Recovery key doesn't match current encryption keys — your identity was reset elsewhere. Use Start fresh to create new keys.");
      } else if (msg.includes("does not match") || msg.includes("Decryption")) {
        setRestoreError("Recovery key doesn't match. Check the key and try again.");
      } else {
        setRestoreError(`Failed: ${msg}`);
      }
    } finally {
      setRestoring(false);
      setRestoreProgress(null);
    }
  }

  // ── Setup & key rotation ────────────────────────────────────────────────────

  async function rotateRecoveryKey() {
    // Spoken refusals, matching applyRecoveryKey — the silent `return` here was
    // a click that did nothing during the lazy-load warmup (latent; the UI's
    // "checking" fence made it unreachable in practice, but a guard that can
    // fire must say so).
    if (!client || status !== "ready") { setSetupError("Matrix not connected yet."); return; }
    const crypto = client.getCrypto?.();
    if (!crypto) { setSetupError("Encryption not initialised."); return; }

    setSetupStep("generating");
    setSetupError(null);

    try {
      const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key");
      let keyToShow = "";

      try {
        await crypto.bootstrapSecretStorage({
          setupNewKeyBackup: true,
          setupNewSecretStorage: true,
          createSecretStorageKey: async () => {
            const privateKey = new Uint8Array(32);
            window.crypto.getRandomValues(privateKey);
            const encodedPrivateKey = encodeRecoveryKey(privateKey) ?? "";
            keyToShow = encodedPrivateKey;
            setPendingSecretStorageKey(privateKey);
            return { privateKey, encodedPrivateKey, keyInfo: {} };
          },
        });

        // Re-run non-destructively so the (unchanged) cross-signing private
        // keys are re-encrypted under the new 4S key.
        await crypto.bootstrapSecretStorage({
          setupNewKeyBackup: false,
          setupNewSecretStorage: false,
        });
      } finally {
        setPendingSecretStorageKey(null);
      }

      setGeneratedKey(keyToShow);
      setSetupStep("show_key");
      await checkCrossSigningStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupStep(null);
      setSetupError(`Failed to rotate key: ${msg}`);
    }
  }

  async function generateAndSetupEncryption(forceNew = false) {
    if (!client || status !== "ready") { setSetupError("Matrix not connected yet."); return; }
    const crypto = client.getCrypto?.();
    if (!crypto) { setSetupError("Encryption not initialised."); return; }

    // First-time setup may only run when the account truly has no identity;
    // anything else must restore or explicitly reset. The UI enforces this,
    // but guard here too — creating a second identity invalidates every other
    // device's verification and every saved recovery key.
    if (!forceNew && flowState !== "setup") {
      setSetupError("This account already has encryption set up. Enter your recovery key instead.");
      return;
    }

    setSetupStep("generating");
    setSetupError(null);
    setResetApprovalUrl(null);

    try {
      const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key");
      let keyToShow = "";

      // "Start fresh": MSC4312 consent, the crypto spec's design-of-record.
      // resetEncryption drops the old backup + 4S pointer and replaces
      // cross-signing; the server refuses the replacement until the user has
      // approved it on their MAS account page, and that refusal carries the
      // approval URL. We surface it and stop — approval arms the server, and
      // the user's retry re-runs this whole function to a clean success. No
      // server-side database pre-clear is needed, so nothing assumes web and
      // Synapse share a host.
      if (forceNew) {
        let refusalUrl: string | null = null;
        try {
          await crypto.resetEncryption(async (makeRequest) => {
            try {
              await makeRequest(null);
            } catch (e) {
              refusalUrl = crossSigningResetUrl(e, {
                account: await accountUrlFromWellKnown(),
                deviceId: client.getDeviceId(),
              });
              throw e;
            }
          });
        } catch (e) {
          if (refusalUrl) {
            // Not an error: the server did its job. Nothing was changed.
            setSetupStep(null);
            setResetApprovalUrl(refusalUrl);
            return;
          }
          throw e;
        }
      }

      // Atomic-or-error: every step below either succeeds or throws into the
      // catch — no error class is "non-fatal" inside setup. A swallowed upload
      // failure here once produced recovery keys for an identity the server
      // never received.
      try {
        await crypto.bootstrapSecretStorage({
          // After a reset, resetEncryption already created the fresh backup;
          // asking for another here would invalidate it.
          setupNewKeyBackup: !forceNew,
          setupNewSecretStorage: forceNew,
          createSecretStorageKey: async () => {
            const privateKey = new Uint8Array(32);
            window.crypto.getRandomValues(privateKey);
            const encodedPrivateKey = encodeRecoveryKey(privateKey) ?? "";
            keyToShow = encodedPrivateKey;
            setPendingSecretStorageKey(privateKey);
            return { privateKey, encodedPrivateKey, keyInfo: {} };
          },
        });

        // First-time setup still uploads the identity here (accepted on the
        // bearer token alone — MSC3967); after a reset, resetEncryption
        // already replaced it and this is a no-op-safe re-assertion.
        if (!forceNew) await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true });

        // Cross-sign this device so it's verified immediately.
        const clientDeviceId = client.getDeviceId();
        if (clientDeviceId) {
          await crypto.crossSignDevice(clientDeviceId);
        }

        // Re-run 4S non-destructively to encrypt the new cross-signing private
        // keys into secret storage. Without this the recovery key restores room
        // keys but not cross-signing verification.
        await crypto.bootstrapSecretStorage({
          setupNewKeyBackup: false,
          setupNewSecretStorage: false,
        });
      } finally {
        setPendingSecretStorageKey(null);
      }

      // Post-condition: the server-published identity exists and trusts this
      // device. Only then is the recovery key real — never show a key for an
      // identity the server doesn't have.
      const ownIdentity = await getOwnIdentity(crypto);
      const trusted = ownIdentity != null
        ? await ownIdentity.trustsOurOwnDevice().catch(() => false)
        : false;
      if (!ownIdentity || !trusted) {
        throw new Error("Setup did not complete: the server did not accept the new identity. Nothing was saved — try again.");
      }

      setGeneratedKey(keyToShow);
      setSetupStep("show_key");
      await checkCrossSigningStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupStep(null);
      if (msg.includes("One time key") || msg.includes("one_time_key")) {
        setSetupError("A key-upload conflict aborted setup. Sign out, sign back in (this creates a fresh session), then try again.");
      } else if (msg.includes("401") || msg.includes("Unknown message") || msg.includes("Interactive auth")) {
        setSetupError("The server requires approval to replace encryption keys. Use 'Start fresh', or approve the reset on your account page and retry.");
      } else if (msg.includes("falsey") || msg.includes("getSecretStorageKey")) {
        setSetupError("This account already has an encryption key set up. Enter your recovery key instead.");
      } else {
        setSetupError(`Setup failed: ${msg}`);
      }
    }
  }

  async function finishSetup() {
    setSetupStep(null);
    setShowSetupFlow(false);
    setGeneratedKey("");
    setKeyCopied(false);
    setKeyVisible(false);
    await checkCrossSigningStatus();
  }

  async function copyKey() {
    await copyText(generatedKey);
    setKeyCopied(true);
    schedule(() => setKeyCopied(false), 2000);
  }

  return {
    verifyPending,
    // recovery key
    showRecoveryKey,
    setShowRecoveryKey,
    recoveryKeyInput,
    setRecoveryKeyInput,
    recoveryKeyVisible,
    setRecoveryKeyVisible,
    restoring,
    restoreProgress,
    restoreResult,
    restoreError,
    setRestoreError,
    restoreNeedsFreshDevice,
    // The remedy is the whole sign-out unit — session, stores, device id
    // together — so the next sign-in mints a fresh device (deviceId.ts).
    startDeviceOver: signOutEverything,
    applyRecoveryKey,
    dismissRecoveryKey,
    startFreshFromKeyError,
    // setup
    showSetupFlow,
    setShowSetupFlow,
    resetApprovalUrl,
    dismissResetApproval,
    setupStep,
    generatedKey,
    setupError,
    setSetupError,
    keyCopied,
    keyVisible,
    setKeyVisible,
    generateAndSetupEncryption,
    rotateRecoveryKey,
    finishSetup,
    copyKey,
  };
}
