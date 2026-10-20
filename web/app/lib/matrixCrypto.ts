import { useCallback, useEffect, useRef } from "react";

// Shared types + helpers for the Matrix encryption/verification hooks
// (useMatrixSettings + its useMatrixVerification / useMatrixEncryptionSetup
// sub-hooks). Kept framework-light so the pieces stay independently testable.

export type Device = {
  device_id: string;
  display_name?: string | null;
  last_seen_ts?: number | null;
  verified?: boolean | null;
};

export type RestoreProgress = { imported: number; total: number } | null;
export type VerifyPhase = "idle" | "incoming" | "outgoing" | "sas" | "waiting" | "done" | "cancelled" | "error";

// Which encryption flow this device should be offered. Derived from SERVER
// state (published identity + 4S account_data), never from local caches —
// a fresh device must restore the existing identity, not create a new one.
export type EncryptionFlow =
  | "checking"   // not connected / state not derived yet
  | "setup"      // no identity anywhere → first-time setup (only path that creates keys)
  | "orphaned"   // 4S exists but no published identity (incomplete setup) → reset
  | "restore"    // identity exists, this device untrusted → recovery key or SAS
  | "verified";  // identity exists and trusts this device

// `getOwnIdentity()` is a Rust-crypto method that isn't on the public CryptoApi
// typings. Narrow to just the shape we use instead of casting the whole crypto
// object to `any`; resolves to null when the method is absent or rejects.
type OwnUserIdentity = { trustsOurOwnDevice(): Promise<boolean> };
export function getOwnIdentity(crypto: unknown): Promise<OwnUserIdentity | null> {
  const fn = (crypto as { getOwnIdentity?: () => Promise<OwnUserIdentity | null> }).getOwnIdentity;
  return fn ? Promise.resolve(fn.call(crypto)).catch(() => null) : Promise.resolve(null);
}

// The OlmMachine's copy of OUR identity is only as fresh as the device-list
// updates it has seen, and the web client syncs from a MemoryStore — every page
// load is an initial sync with no device_lists history. A cross-signing
// signature added to this device while the tab was closed is therefore never
// fetched, and `trustsOurOwnDevice()` stays false on a device the server has
// already signed (a restore would end in a false "stale signature" verdict).
// `CryptoApi.userHasCrossSigningKeys(ownUserId)` is the public lever:
// for a tracked own user the rust layer issues and awaits a fresh /keys/query
// before answering, which is exactly the refresh. The boolean it returns is
// not the point; the side effect is. Best-effort: a failed query changes
// nothing, and the caller's existing local read stands.
export async function refreshOwnIdentityFromServer(crypto: unknown, userId: string): Promise<void> {
  const fn = (crypto as { userHasCrossSigningKeys?: (userId: string) => Promise<boolean> } | null)?.userHasCrossSigningKeys;
  if (!fn) return;
  try { await fn.call(crypto, userId); } catch {}
}

export type Schedule = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

// All transient verification/copy timers, cleared on unmount so closing the
// settings panel mid-flow can't trigger setState-after-unmount or leak timers.
export function useTimers(): Schedule {
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const schedule = useCallback<Schedule>((fn, ms) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn(); }, ms);
    timersRef.current.add(id);
    return id;
  }, []);
  useEffect(() => () => { timersRef.current.forEach(clearTimeout); timersRef.current.clear(); }, []);
  return schedule;
}

// MSC4312 consent (the design for "Start fresh"): a Synapse that delegates
// auth to MAS refuses a cross-signing REPLACEMENT with a UIA 401 whose params
// carry the account page's approval URL — the user approves there, then the
// retry's upload is accepted. This extracts that URL from the refusal; when
// the server didn't include one (older payload shapes), it falls back to
// building the MSC4191 deep link from the well-known's account URL, so the
// button never dead-ends. Pure on purpose: the hook supplies both inputs, the
// tests hand-check both paths. No host-level access (a database pre-clear)
// is involved, so nothing here can die silently when hosts move.
// @test-only the tests build MSC4312 refusal payloads from the SAME stage
// string the extractor matches — two restated literals could drift while every
// assertion stayed green. Runtime consumers use crossSigningResetUrl, not this.
export const CROSS_SIGNING_RESET_STAGE = "org.matrix.cross_signing_reset";

export function crossSigningResetUrl(
  err: unknown,
  fallback: { account?: string | null; deviceId?: string | null },
): string | null {
  const params = (err as { data?: { params?: Record<string, unknown> } } | null)
    ?.data?.params?.[CROSS_SIGNING_RESET_STAGE];
  const url = (params as { url?: unknown } | undefined)?.url;
  if (typeof url === "string" && /^https?:\/\//.test(url)) return url;
  if (fallback.account && /^https?:\/\//.test(fallback.account)) {
    const u = new URL(fallback.account);
    u.searchParams.set("action", CROSS_SIGNING_RESET_STAGE);
    if (fallback.deviceId) u.searchParams.set("device_id", fallback.deviceId);
    return u.toString();
  }
  return null;
}
