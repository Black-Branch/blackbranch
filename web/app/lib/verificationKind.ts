// Who a verification request is with: your own other device (Settings › Encryption answers it) or
// another person (the person-to-person prompt answers it). One request, one surface — and one
// pending slot per kind, so a request of one kind never replaces a waiting one of the other.
import { PHASE_CANCELLED, PHASE_DONE } from "./matrixVerification.ts";

export type VerificationKind = "self" | "user";

export function verificationKind(req: { otherUserId: string; isSelfVerification: boolean }, me: string): VerificationKind {
  return req.isSelfVerification || req.otherUserId === me ? "self" : "user";
}

/** The pending slot a request goes to, or null for a finished one (Cancelled/Done — replayed by
 *  sync catch-up, the "ghost SAS" request). */
export function verificationSlot(req: { otherUserId: string; isSelfVerification: boolean; phase: number }, me: string): VerificationKind | null {
  if (req.phase === PHASE_CANCELLED || req.phase === PHASE_DONE) return null;
  return verificationKind(req, me);
}
