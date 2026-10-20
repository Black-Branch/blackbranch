import { useEffect, useState } from "react";
// Explicit file paths, not the `@/` alias or the SDK's directory specifier:
// useMatrixVerification.render.test.ts mounts this hook under `node --test`,
// which resolves neither (same rule as useSendDestination.ts).
import { VerificationRequestEvent, VerifierEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { VerificationRequest, ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api";
import type { MatrixClient } from "matrix-js-sdk";
import { PHASE_READY, PHASE_CANCELLED } from "./matrixVerification.ts";
import type { VerifyPhase, Schedule } from "./matrixCrypto.ts";

// SAS device-verification flow extracted from useMatrixSettings.
//
// The rust SDK runs the whole m.key.verification state machine; on success it
// uploads signatures and gossips cross-signing/backup secrets to the newly
// verified device by itself. Our job is to render its states:
//   success  = the verifier.verify() promise RESOLVING (nothing else)
//   emoji    = VerifierEvent.ShowSas
//   progress = VerificationRequestEvent.Change
// No timers, no polling, no assumed outcomes.
export function useMatrixVerification({
  client,
  pendingVerification,
  clearPendingVerification,
  checkCrossSigningStatus,
  schedule,
  consume = true,
}: {
  client: MatrixClient | null;
  pendingVerification: unknown;
  clearPendingVerification: () => void;
  checkCrossSigningStatus: () => Promise<void>;
  schedule: Schedule;
  /** False for a mount that renders no verification UI (see useMatrixSettings). */
  consume?: boolean;
}) {
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>("idle");
  const [verifyPeer, setVerifyPeer] = useState("");
  const [verifyRequest, setVerifyRequest] = useState<VerificationRequest | null>(null);
  const [sasEmoji, setSasEmoji] = useState<Array<[string, string]> | null>(null);
  const [sasCallbacks, setSasCallbacks] = useState<ShowSasCallbacks | null>(null);

  // ── Consume incoming verification request from context ──────────────────────
  // The request is one-shot: whichever mount takes it acks the provider, and
  // no other mount sees it again. A mount with `consume` off must not touch it.

  useEffect(() => {
    if (!consume || !pendingVerification || verifyPhase !== "idle") return;
    const req = pendingVerification as VerificationRequest;
    const peer = req.otherDeviceId ?? req.otherUserId ?? "unknown device";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: consumes a one-shot context event (moves it into local state, then acks the provider); deferring would open a race in verification handling
    setVerifyPeer(peer);
    setVerifyRequest(req);
    setVerifyPhase("incoming");
    clearPendingVerification();
  }, [consume, pendingVerification, verifyPhase, clearPendingVerification]);

  function resetVerify() {
    setVerifyPhase("idle");
    setVerifyRequest(null);
    setSasEmoji(null);
    setSasCallbacks(null);
    setVerifyPeer("");
  }

  /** Resolve when request.phase passes the predicate (or immediately if it already does). */
  async function waitForRequest(request: VerificationRequest, pred: (phase: number) => boolean, timeoutMs: number): Promise<boolean> {
    if (pred(request.phase)) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(pred(request.phase)); }, timeoutMs);
      const onChange = () => {
        if (pred(request.phase)) { cleanup(); resolve(true); }
      };
      const cleanup = () => {
        clearTimeout(timer);
        request.off(VerificationRequestEvent.Change, onChange);
      };
      request.on(VerificationRequestEvent.Change, onChange);
    });
  }

  /** Run a SAS verification on a request that is Ready (or already Started by the peer). */
  async function runSas(request: VerificationRequest) {
    setVerifyPhase("sas");
    let verifier = request.verifier;
    try {
      if (!verifier) {
        verifier = await request.startVerification("m.sas.v1");
      }
      const onShowSas = (sas: ShowSasCallbacks) => {
        setSasEmoji(sas.sas.emoji ?? null);
        setSasCallbacks(sas);
      };
      verifier.on(VerifierEvent.ShowSas, onShowSas);
      // If the peer already produced the SAS before we attached the listener:
      const existing = verifier.getShowSasCallbacks();
      if (existing) onShowSas(existing);

      try {
        await verifier.verify(); // resolves on Done, rejects on cancel/mismatch
        setVerifyPhase("done");
        await checkCrossSigningStatus();
        schedule(resetVerify, 2500);
      } finally {
        verifier.off(VerifierEvent.ShowSas, onShowSas);
      }
    } catch {
      setVerifyPhase(request.phase === PHASE_CANCELLED ? "cancelled" : "error");
      schedule(resetVerify, 3000);
    }
  }

  async function acceptIncoming() {
    if (!verifyRequest) return;
    try {
      await verifyRequest.accept?.();
      // Give the initiating side a moment to choose the method; if it doesn't
      // start, we do. runSas handles both (request.verifier ?? start ourselves).
      await waitForRequest(verifyRequest, (p) => p >= PHASE_READY, 1500);
      await runSas(verifyRequest);
    } catch {
      setVerifyPhase("error");
      schedule(resetVerify, 3000);
    }
  }

  async function declineVerify() {
    try { await verifyRequest?.cancel?.(); } catch {}
    setVerifyPhase("cancelled");
    schedule(resetVerify, 2000);
  }

  async function startOutgoing(deviceId: string, deviceName: string) {
    if (!client) return;
    const crypto = client.getCrypto?.();
    const userId = client.getUserId();
    if (!crypto || !userId) return;
    setVerifyPeer(deviceName);
    setVerifyPhase("outgoing");
    try {
      const request = await crypto.requestDeviceVerification(userId, deviceId);
      setVerifyRequest(request);
      const ready = await waitForRequest(
        request,
        (p) => p >= PHASE_READY && p !== PHASE_CANCELLED,
        60_000
      );
      if (request.phase === PHASE_CANCELLED) {
        setVerifyPhase("cancelled");
        schedule(resetVerify, 3000);
        return;
      }
      if (!ready) {
        setVerifyPhase("error");
        schedule(resetVerify, 3000);
        return;
      }
      await runSas(request);
    } catch {
      setVerifyPhase("error");
      schedule(resetVerify, 3000);
    }
  }

  async function confirmSas() {
    if (!sasCallbacks) return;
    // confirm() sends our MAC; the verify() promise inside runSas resolves once
    // both sides are done — that's what flips the phase to "done".
    setVerifyPhase("waiting");
    try {
      await sasCallbacks.confirm?.();
    } catch {
      // verify() inside runSas rejects too and owns the error/cancel UI.
    }
  }

  async function mismatchSas() {
    try { await sasCallbacks?.mismatch?.(); } catch {}
    setVerifyPhase("cancelled");
    schedule(resetVerify, 2000);
  }

  return {
    verifyPhase,
    verifyPeer,
    sasEmoji,
    acceptIncoming,
    declineVerify,
    startOutgoing,
    confirmSas,
    mismatchSas,
  };
}
