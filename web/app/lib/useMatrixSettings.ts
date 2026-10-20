import { useEffect, useState, useCallback, useRef } from "react";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { useMatrixClient } from "@/app/lib/MatrixClientContext";
import {
  getOwnIdentity,
  refreshOwnIdentityFromServer,
  useTimers,
} from "@/app/lib/matrixCrypto";
import type { Device, EncryptionFlow } from "@/app/lib/matrixCrypto";
import { useMatrixVerification } from "@/app/lib/useMatrixVerification";
import { useMatrixEncryptionSetup } from "@/app/lib/useMatrixEncryptionSetup";
import { getJson } from "@/app/lib/http";

// Re-export the shared types so existing consumers keep importing them from here.
export type { Device, RestoreProgress, VerifyPhase, EncryptionFlow } from "@/app/lib/matrixCrypto";

export function useMatrixSettings({
  onEncryptionChange,
  consumeVerification = true,
}: {
  onEncryptionChange?: (status: "green" | "yellow" | "red") => void;
  /** Whether this mount takes an incoming verification request (moves it into
   *  its own state and acks the provider). Devices & Security renders the
   *  request, so it consumes; a mount that only reads flowState — the
   *  "Secure your account" nudge — must pass false, or the request vanishes
   *  into a hook with no UI for it. */
  consumeVerification?: boolean;
}) {
  const { client, status, pendingVerification, clearPendingVerification, retry } = useMatrixClient();
  const currentDeviceId = client?.getDeviceId() ?? null;

  // ── Device list ─────────────────────────────────────────────────────────────

  const [devices, setDevices] = useState<Device[] | null>(null);
  const [accountUrl, setAccountUrl] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeErrors, setRemoveErrors] = useState<Record<string, string>>({});

  // ── Cross-signing status ────────────────────────────────────────────────────
  // crossSigningOk = the published identity cross-signs THIS device. That is
  // the only definition of "verified" — local private-key caches
  // (isCrossSigningReady) can be true while the server has nothing, which is
  // how a broken setup once showed a false green.

  const [crossSigningOk, setCrossSigningOk] = useState<boolean | null>(null);
  const [hasServerIdentity, setHasServerIdentity] = useState<boolean | null>(null);
  const [fourSExists, setFourSExists] = useState<boolean | null>(null);
  const [backupActive, setBackupActive] = useState<boolean | null>(null);

  const flowState: EncryptionFlow =
    status !== "ready" || crossSigningOk === null || hasServerIdentity === null || fourSExists === null
      ? "checking"
      : hasServerIdentity
        ? (crossSigningOk ? "verified" : "restore")
        : fourSExists
          ? "orphaned"
          : "setup";

  // Shared transient-timer scheduler (cleared on unmount), handed to the
  // verification + encryption-setup sub-hooks.
  const schedule = useTimers();

  // ── Cross-signing status check ──────────────────────────────────────────────

  // The local trust read is a snapshot of the last device-list update the
  // OlmMachine saw, and this client's MemoryStore sync never replays history —
  // a signature added to this device while the tab was closed is invisible to
  // it (a device the server had signed would show "Device not verified", with
  // no Verify button and a false "stale" verdict on restore). When the server
  // has an identity that doesn't trust us, ask it once per mount before
  // publishing the verdict. Once: a genuinely untrusted device must not fire a
  // /keys/query on every UserTrustStatusChanged re-check.
  const refreshedOwnIdentityRef = useRef(false);

  const checkCrossSigningStatus = useCallback(async () => {
    if (status !== "ready" || !client) return;
    const crypto = client.getCrypto?.();
    if (!crypto) { setCrossSigningOk(false); setHasServerIdentity(false); return; }

    let ownIdentity = await getOwnIdentity(crypto);
    let trusted = ownIdentity != null
      ? await ownIdentity.trustsOurOwnDevice().catch(() => false)
      : false;
    const ownUserId = client.getUserId();
    if (ownIdentity != null && !trusted && ownUserId && !refreshedOwnIdentityRef.current) {
      refreshedOwnIdentityRef.current = true;
      await refreshOwnIdentityFromServer(crypto, ownUserId);
      ownIdentity = await getOwnIdentity(crypto);
      trusted = ownIdentity != null
        ? await ownIdentity.trustsOurOwnDevice().catch(() => false)
        : false;
    }
    setHasServerIdentity(ownIdentity != null);
    setCrossSigningOk(trusted);

    const defaultKeyId = await client.secretStorage.getDefaultKeyId().catch(() => null);
    setFourSExists(defaultKeyId != null);

    const backupVersion = await crypto.getActiveSessionBackupVersion().catch(() => null);
    setBackupActive(backupVersion != null);
  }, [status, client]);

  // Microtask defer keeps the sync no-crypto branch's setStates out of the effect pass.
  useEffect(() => { Promise.resolve().then(checkCrossSigningStatus); }, [checkCrossSigningStatus]);

  useEffect(() => {
    if (status !== "ready" || !client) return;
    const userId = client.getUserId();
    const handler = (changedUserId: string) => {
      if (changedUserId === userId) checkCrossSigningStatus();
    };
    client.on(CryptoEvent.UserTrustStatusChanged, handler);
    return () => { client.off(CryptoEvent.UserTrustStatusChanged, handler); };
  }, [status, client, checkCrossSigningStatus]);

  // Traffic light: fires whenever verification state or device list changes.
  useEffect(() => {
    if (crossSigningOk === null || devices === null) return;
    if (!crossSigningOk) { onEncryptionChange?.("red"); return; }
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const hasOtherIssues = devices.some((d) => {
      if (d.device_id === currentDeviceId) return false;
      if (d.verified === false) return true;
      if (d.last_seen_ts != null && now - d.last_seen_ts > thirtyDays) return true;
      return false;
    });
    onEncryptionChange?.(hasOtherIssues ? "yellow" : "green");
  }, [crossSigningOk, devices, currentDeviceId, onEncryptionChange]);

  // ── Device fetch ────────────────────────────────────────────────────────────

  useEffect(() => {
    getJson<{ devices?: Device[]; accountUrl?: string }>("/api/matrix/devices")
      .then((d) => {
        setDevices(d.devices?.map((dev: Device) => ({ ...dev, verified: null })) ?? []);
        if (d.accountUrl) setAccountUrl(d.accountUrl);
      })
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    if (status !== "ready" || !client || !devices) return;
    const crypto = client.getCrypto?.();
    const userId = client.getUserId();
    if (!crypto || !userId) return;
    Promise.allSettled(
      devices.map(async (d) => {
        const vs = await crypto.getDeviceVerificationStatus(userId, d.device_id).catch(() => null);
        return { device_id: d.device_id, verified: vs?.crossSigningVerified ?? false };
      })
    ).then((results) => {
      setDevices((prev) => {
        if (!prev) return prev;
        const map: Record<string, boolean> = {};
        for (const r of results) {
          if (r.status === "fulfilled") map[r.value.device_id] = r.value.verified;
        }
        return prev.map((d) => (d.device_id in map ? { ...d, verified: map[d.device_id] } : d));
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on devices?.LENGTH, never on `devices`: this effect WRITES devices (setDevices below mints a new array), so listing the array itself is an unconditional infinite loop. Verification status is fetched once per device list, which is what the length identifies
  }, [status, client, devices?.length]);

  // ── SAS verification + recovery/setup flows (extracted) ─────────────────────

  const verification = useMatrixVerification({
    client,
    pendingVerification,
    clearPendingVerification,
    checkCrossSigningStatus,
    schedule,
    consume: consumeVerification,
  });

  const encryptionSetup = useMatrixEncryptionSetup({
    client,
    status,
    flowState,
    checkCrossSigningStatus,
    schedule,
  });

  // ── Device removal ──────────────────────────────────────────────────────────

  async function removeDevice(deviceId: string) {
    setRemoving(deviceId);
    setRemoveErrors((prev) => { const n = { ...prev }; delete n[deviceId]; return n; });
    try {
      const res = await fetch(`/api/matrix/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setDevices((prev) => prev?.filter((d) => d.device_id !== deviceId) ?? null);
      } else {
        setRemoveErrors((prev) => ({ ...prev, [deviceId]: "requires-reauth" }));
      }
    } catch {
      setRemoveErrors((prev) => ({ ...prev, [deviceId]: "failed" }));
    } finally {
      setRemoving(null);
    }
  }

  const sorted = devices
    ? [...devices].sort((a, b) => {
        if (a.device_id === currentDeviceId) return -1;
        if (b.device_id === currentDeviceId) return 1;
        return (b.last_seen_ts ?? 0) - (a.last_seen_ts ?? 0);
      })
    : null;

  return {
    // status
    status,
    retry,
    currentDeviceId,
    crossSigningOk,
    hasCrossSigningKeys: hasServerIdentity, // server-published identity (UI prop name kept)
    flowState,
    backupActive,
    checkCrossSigningStatus,
    // SAS
    ...verification,
    // recovery key + setup (incl. verifyPending)
    ...encryptionSetup,
    // devices
    sorted,
    removing,
    removeErrors,
    removeDevice,
    accountUrl,
  };
}

export type MatrixSettingsState = ReturnType<typeof useMatrixSettings>;
