import { useEffect, useState } from "react";
// Explicit file paths, not the `@/` alias or the SDK's directory specifier:
// useMatrixVerification.render.test.ts mounts this hook under `node --test`,
// which resolves neither (same rule as useSendDestination.ts).
import { VerificationRequestEvent, VerifierEvent } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { VerificationRequest, ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api";
import type { MatrixClient } from "matrix-js-sdk";
import { PHASE_READY, PHASE_CANCELLED, PHASE_DONE } from "./matrixVerification.ts";
import { verificationKind, type VerificationKind } from "./verificationKind.ts";
import type { VerifyPhase, Schedule } from "./matrixCrypto.ts";

/** How long an outgoing request waits for the other side. Your own device is at hand; a person may
 *  first have to accept the conversation the request sits in (the SDK ends it at 10 minutes). */
const OUTGOING_WAIT_MS: Record<VerificationKind, number> = { self: 60_000, user: 10 * 60_000 };

// SAS verification, of your own other device (`kind: "self"`, Settings) or of another person
// (`kind: "user"`, the person-to-person prompt).
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
  kind,
  pendingVerification,
  clearPendingVerification,
  checkCrossSigningStatus,
  schedule,
  consume = true,
}: {
  client: MatrixClient | null;
  /** Which requests this mount answers; the other kind stays pending for its own surface. */
  kind: VerificationKind;
  pendingVerification: unknown;
  clearPendingVerification: () => void;
  checkCrossSigningStatus: () => Promise<void>;
  schedule: Schedule;
  /** False for a mount that renders no verification UI (see useMatrixSettings). */
  consume?: boolean;
}) {
  const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>("idle");
  const [verifyPeer, setVerifyPeer] = useState("");
  /** The other person's user id (kind "user"): shown beside the free-text display name, which
   *  anyone can set to someone else's. */
  const [verifyPeerId, setVerifyPeerId] = useState("");
  const [verifyRequest, setVerifyRequest] = useState<VerificationRequest | null>(null);
  const [sasEmoji, setSasEmoji] = useState<Array<[string, string]> | null>(null);
  const [sasCallbacks, setSasCallbacks] = useState<ShowSasCallbacks | null>(null);

  /** The name a person reads: a device id for your own device, a display name for a person. */
  const peerName = (req: VerificationRequest) =>
    kind === "user"
      ? client?.getUser(req.otherUserId)?.displayName || req.otherUserId
      : req.otherDeviceId ?? req.otherUserId ?? "unknown device";

  // ── Consume a pending request from context ──────────────────────────────────
  // The request is one-shot: whichever mount takes it acks the provider, and
  // no other mount sees it again. A mount with `consume` off, or of the other
  // kind, must not touch it. A request WE made (the member card's Verify) is
  // handed over the same way and is followed until the other side is ready.

  useEffect(() => {
    if (!consume || !pendingVerification || verifyPhase !== "idle") return;
    const req = pendingVerification as VerificationRequest;
    if (verificationKind(req, client?.getUserId() ?? "") !== kind) return;
    // One that ended while it waited in its slot (the other side cancelled, it expired, or it was
    // answered elsewhere) is not a question any more: empty the slot and show nothing.
    if (req.phase === PHASE_CANCELLED || req.phase === PHASE_DONE) { clearPendingVerification(); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: consumes a one-shot context event (moves it into local state, then acks the provider); deferring would open a race in verification handling
    setVerifyPeer(peerName(req));
    setVerifyPeerId(kind === "user" ? req.otherUserId : "");
    setVerifyRequest(req);
    clearPendingVerification();
    if (req.initiatedByMe) void followOutgoing(req);
    else setVerifyPhase("incoming");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- peerName and followOutgoing are re-made each render and read only `client`/`kind` (both listed) and state setters
  }, [consume, kind, client, pendingVerification, verifyPhase, clearPendingVerification]);

  // While a request waits for our answer, the other side can still end it (they close their window,
  // the request expires after 10 minutes, or another of our devices answered it): the question
  // must go, never stay up with an Accept that can only fail.
  useEffect(() => {
    if (verifyPhase !== "incoming" || !verifyRequest) return;
    const req = verifyRequest;
    const onChange = () => {
      if (req.phase === PHASE_CANCELLED) {
        setVerifyPhase("cancelled");
        schedule(resetVerify, 3000);
      } else if (req.phase === PHASE_DONE) {
        resetVerify();
      }
    };
    req.on(VerificationRequestEvent.Change, onChange);
    onChange(); // it may have ended between the take-over and this subscription
    return () => { req.off(VerificationRequestEvent.Change, onChange); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resetVerify only calls state setters; schedule is the caller's stable timer helper
  }, [verifyPhase, verifyRequest]);

  function resetVerify() {
    setVerifyPhase("idle");
    setVerifyRequest(null);
    setSasEmoji(null);
    setSasCallbacks(null);
    setVerifyPeer("");
    setVerifyPeerId("");
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

  /** Our own request: wait for the other side to accept, then the emoji. */
  async function followOutgoing(request: VerificationRequest) {
    setVerifyPhase("outgoing");
    try {
      // Ready, Started, Cancelled and Done all end the wait (each is at or past Ready).
      const moved = await waitForRequest(request, (p) => p >= PHASE_READY, OUTGOING_WAIT_MS[kind]);
      if (request.phase === PHASE_CANCELLED) {
        setVerifyPhase("cancelled");
        schedule(resetVerify, 3000);
        return;
      }
      if (!moved) {
        await request.cancel?.().catch(() => {});
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
      await followOutgoing(request);
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
    verifyPeerId,
    sasEmoji,
    acceptIncoming,
    declineVerify,
    /** Close a finished state (done / cancelled / error) at once instead of after its pause. */
    dismissVerify: resetVerify,
    startOutgoing,
    confirmSas,
    mismatchSas,
  };
}
