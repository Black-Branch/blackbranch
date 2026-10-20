"use client";

import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { useMatrixClient, useMatrixIdentity } from "./MatrixClientContext";
import {
  readRememberedVerdict, rememberVerdict, effectiveVerdict,
  type EncryptionVerdict,
} from "./encryptionMemory";
import { useClientValue } from "./useClientState";

// One shared derivation of the E2EE traffic-light state (was copy-pasted across
// UserMenu, the community rail's avatar button, and now the profile card's
// encryption row). Computes the cross-signing verdict for the own device, and
// live-updates when the Devices & Security panel broadcasts a change via the
// `bb:encryption-status` window event (the panel's host dispatches it from
// MatrixSettings' onEncryptionChange).
//
// The verdict is PER-MOUNT state on purpose: the broadcast can carry "yellow",
// which the crypto check below can never produce (it only knows green/red), so
// a shared/global verdict would let any later mount's check erase a broadcast
// yellow from every surface at once. Only the expensive crypto round-trip is
// shared — see computeVerdictShared.

// Declared in encryptionMemory (which imports nothing) and re-exported here,
// where every existing caller already looks for it.
export type { EncryptionVerdict };

// @test-only matrixIdentity.test.ts pins the dot state classes.
export function encryptionDotClass(
  verdict: EncryptionVerdict,
  pendingVerification: boolean
): string | null {
  // Pending verification overrides the cross-signing state — it needs eyes
  // now, and it's the ONLY state that pulses: it's transient. Red (not
  // cross-signed) is the long-lived common case, and an infinite pulse in the
  // always-mounted composer is permanent idle animation for a state that can
  // sit for weeks — static red carries the same information.
  return pendingVerification
    ? "bg-yellow-400 animate-pulse"
    : verdict === "green"
    ? "bg-green-400"
    : verdict === "yellow"
    ? "bg-yellow-400"
    // UNKNOWN reads as RED: a dot even if Matrix has yet to load. Returning
    // null would make the row say "Encryption needs setup" with no dot beside
    // it — the text asserting a state the indicator declines to show, which is
    // the worst of both. Unknown and red also want the same ACTION from the
    // user: open Devices & Security. The only reason this is safe to conflate
    // is that a device which has been set up reports "green" from the
    // remembered verdict long before the client is ready — see
    // encryptionMemory.
    : "bg-red-400";
}

// Single-flight for the getDeviceVerificationStatus round-trip only: 2-3
// mounts land concurrently (chat bar, rail button, profile-card row) and share
// one in-flight check instead of each running their own. Keyed by client
// instance so a watchdog client reset never reuses a stale client's promise;
// the slot clears once settled, so a later mount re-verifies fresh. Each mount
// applies the result to its OWN state through its own cancelled guard — the
// observable per-mount semantics are untouched.
let inflight: { client: MatrixClient; promise: Promise<EncryptionVerdict> } | null = null;
function computeVerdictShared(client: MatrixClient): Promise<EncryptionVerdict> {
  if (inflight?.client === client) return inflight.promise;
  const promise = (async () => {
    const crypto = client.getCrypto?.();
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (!crypto || !userId || !deviceId) return "red" as const;
    const vs = await crypto.getDeviceVerificationStatus(userId, deviceId).catch(() => null);
    return (vs?.crossSigningVerified ?? false) ? ("green" as const) : ("red" as const);
  })().finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { client, promise };
  return promise;
}

export function useEncryptionStatus(): {
  verdict: EncryptionVerdict;
  pendingVerification: boolean;
  dotClass: string | null;
} {
  const { client, status, pendingVerification } = useMatrixClient();
  const { matrixId } = useMatrixIdentity();
  const [verdict, setVerdict] = useState<EncryptionVerdict>(null);

  // The LAST KNOWN verdict, available before the client is anywhere near
  // ready. Without it the row reads "Encryption needs setup" for everyone on
  // every load until Matrix syncs — wrong, and wrong in the direction that makes
  // people redo setup they had already done. See encryptionMemory for why we
  // remember rather than boot the client to ask.
  //
  // DERIVED, not synced into state. Two constraints meet here: reading
  // localStorage during render would make the server and client markup disagree
  // (this drives a className), and copying it into state from an effect is the
  // cascading-render pattern eslint refuses. `useClientValue` is exactly this
  // shape — `null` on the server, the real value once hydrated, no effect.
  const remembered = useClientValue(() => readRememberedVerdict(matrixId), null);
  // A computed verdict always wins; the memory only ever fills the gap before
  // one exists. It must never overwrite a live answer.
  const effective = effectiveVerdict(verdict, remembered);

  useEffect(() => {
    if (status !== "ready" || !client) return;
    let cancelled = false;
    // Verdict computed in the async chain; the setState only fires in the
    // .then callback (never synchronously in the effect body).
    computeVerdictShared(client).then((d) => {
      if (cancelled) return;
      setVerdict(d);
      rememberVerdict(matrixId ?? client.getUserId(), d);
    });
    return () => { cancelled = true; };
  }, [status, client, matrixId]);

  useEffect(() => {
    function onEnc(e: Event) {
      const s = (e as CustomEvent).detail;
      if (s === "green" || s === "yellow" || s === "red") {
        setVerdict(s);
        // The Devices & Security panel is the one place that can produce
        // "yellow", and it is also where a user actually FIXES their setup —
        // so this broadcast is the most authoritative verdict we ever see.
        rememberVerdict(matrixId, s);
      }
    }
    window.addEventListener("bb:encryption-status", onEnc);
    return () => window.removeEventListener("bb:encryption-status", onEnc);
  }, [matrixId]);

  return {
    verdict: effective,
    pendingVerification: !!pendingVerification,
    dotClass: encryptionDotClass(effective, !!pendingVerification),
  };
}
