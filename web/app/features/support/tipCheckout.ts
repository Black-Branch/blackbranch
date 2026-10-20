import type { TipDraft } from "./types";

/** The card-checkout request for a TipForm draft. Announce on = a tip:
 *  /api/billing/donate with the full body. Announce
 *  off = a quiet Qorm purchase: /api/billing/points with ONLY the amount — a
 *  quiet buy has no message, and a name must never travel where nothing
 *  needs it (real-name rule). Both routes answer { clientSecret, sessionId },
 *  so a host's embedded checkout is the same either way. */
export function checkoutRequestFor(draft: TipDraft): {
  endpoint: "/api/billing/donate" | "/api/billing/points";
  body: Record<string, unknown>;
} {
  if (!draft.announce) return { endpoint: "/api/billing/points", body: { amount: draft.amount } };
  return {
    endpoint: "/api/billing/donate",
    body: {
      amount: draft.amount,
      message: draft.message.trim() || undefined,
      displayName: draft.displayName,
      anonymous: draft.anonymous,
    },
  };
}
