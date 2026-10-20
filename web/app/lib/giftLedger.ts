import type { GiftPurchaseView } from "./supportStatus";

// The gifter's ledger: everything a viewer has gifted,
// grouped per purchase. PURE — the rows arrive from giftLedgerServer.ts, which
// owns the queries; this file imports nothing that touches the database so
// the grouping is tested on plain rows (giftLedger.test.ts).
//
// One Stripe checkout session is one purchase. A community gift of N slots is
// one session with a gift_subscriptions row per recipient reached so far and a
// gift_pending row per slot that had nobody to go to at purchase time; when a
// new member claims one, the pending row is marked claimed_by AND a
// gift_subscriptions row is written for the same session. Recipients therefore
// come from gift_subscriptions alone; only UNCLAIMED, unexpired pending rows
// count as "waiting".

export type GiftGivenRow = {
  stripe_session_id: string;
  kind: "direct" | "community";
  months: number;
  anonymous: boolean;
  created_at: string | Date;
  /** Already resolved by the server: display name, else the Matrix local part. */
  recipient_name: string;
  expires_at: string | Date;
};

export type GiftPendingRow = {
  stripe_session_id: string;
  months: number;
  anonymous: boolean;
  created_at: string | Date;
  claimed_by: string | null;
  claimed_at: string | Date | null;
  claim_expires_at: string | Date;
};

export const iso = (d: string | Date): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Group raw rows into purchases, newest first. */
export function groupGiftPurchases(given: GiftGivenRow[], pending: GiftPendingRow[], now: Date): GiftPurchaseView[] {
  const bySession = new Map<string, GiftPurchaseView>();
  const ensure = (sessionId: string, seed: Omit<GiftPurchaseView, "sessionId" | "recipients" | "waiting" | "waitingUntil">) => {
    let p = bySession.get(sessionId);
    if (!p) {
      p = { sessionId, ...seed, recipients: [], waiting: 0, waitingUntil: null };
      bySession.set(sessionId, p);
    }
    return p;
  };

  for (const g of given) {
    const p = ensure(g.stripe_session_id, { kind: g.kind, months: g.months, anonymous: g.anonymous, createdAt: iso(g.created_at) });
    // The purchase's date is its earliest grant — a slot claimed weeks later
    // must not make the purchase look newer than it is.
    if (iso(g.created_at) < p.createdAt) p.createdAt = iso(g.created_at);
    const expiresAt = iso(g.expires_at);
    p.recipients.push({ name: g.recipient_name, expiresAt, active: new Date(expiresAt) > now });
  }

  for (const s of pending) {
    // A pending row only ever belongs to a community gift.
    const p = ensure(s.stripe_session_id, { kind: "community", months: s.months, anonymous: s.anonymous, createdAt: iso(s.created_at) });
    if (s.claimed_by) continue; // already counted through its gift_subscriptions row
    const until = iso(s.claim_expires_at);
    if (new Date(until) <= now) continue; // lapsed — the hourly sweep will drop it
    p.waiting += 1;
    if (p.waitingUntil == null || until > p.waitingUntil) p.waitingUntil = until;
  }

  return [...bySession.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
