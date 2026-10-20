// The sentences the Support panel shows about a subscription and about gifts —
// pure functions of the data and a clock, so the copy is tested against fixed
// dates (supportStatus.test.ts) rather than read off a screen.
//
// Three things a subscriber needs to see: how long the sub has left, whether
// renewal is on or off, and — for a gifter — whether a gift went through, its
// length, whether it was claimed and whether it is active now. Everything below
// exists to answer those in plain words.

/** What the Support panel knows about the viewer, from /api/me. */
export type SubscriptionView = {
  /** The viewer's OWN Stripe subscription tier while it is active; null otherwise. */
  tier: string | null;
  subStatus: string | null;
  /** current_period_end — the renewal date, or the access-end date when renewal is off. */
  subRenewsAt: string | null;
  /** Stripe's cancel_at_period_end: the viewer switched renewal off in the portal. */
  subCancelAtPeriodEnd: boolean;
  giftActive: boolean;
  giftExpiresAt: string | null;
  /** Who gave the current gift, or null when anonymous / unknown. */
  giftFrom: string | null;
};

export type StatusTone = "renews" | "ending" | "gift" | "ended";

export type DateFormatter = (d: Date) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until `iso`, rounded up, never negative — "1 day" at 23 hours left. */
function daysLeft(iso: string, now: Date): number {
  const ms = new Date(iso).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

const defaultFormat: DateFormatter = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "Renews on Oct 13 (29 days)" and its siblings, or null when there is nothing to say. */
export function subscriptionStatusLine(
  me: SubscriptionView,
  now: Date = new Date(),
  fmt: DateFormatter = defaultFormat
): { tone: StatusTone; text: string } | null {
  if (me.tier != null && me.subRenewsAt) {
    const date = fmt(new Date(me.subRenewsAt));
    const left = days(daysLeft(me.subRenewsAt, now));
    if (me.subStatus === "past_due") {
      return { tone: "ending", text: `Payment due — access ends ${date} (${left} left) unless the card goes through` };
    }
    if (me.subCancelAtPeriodEnd) {
      return { tone: "ending", text: `Renewal is off — access ends ${date} (${left} left)` };
    }
    return { tone: "renews", text: `Renews on ${date} (${left})` };
  }
  if (me.giftActive && me.giftExpiresAt) {
    const date = fmt(new Date(me.giftExpiresAt));
    const left = days(daysLeft(me.giftExpiresAt, now));
    const from = me.giftFrom ? ` from ${me.giftFrom}` : "";
    return { tone: "gift", text: `Supporter via a gift${from} — until ${date} (${left} left)` };
  }
  if (me.subStatus === "canceled" && me.subRenewsAt) {
    return { tone: "ended", text: `Your subscription ended on ${fmt(new Date(me.subRenewsAt))}` };
  }
  return null;
}

/** One gift purchase as the gifter's ledger shows it (from /api/billing/gifts). */
export type GiftPurchaseView = {
  sessionId: string;
  kind: "direct" | "community";
  months: number;
  anonymous: boolean;
  createdAt: string;
  /** Everyone this purchase has reached so far, with each one's own end date. */
  recipients: { name: string; expiresAt: string; active: boolean }[];
  /** Community slots nobody has claimed yet. */
  waiting: number;
  /** When the waiting slots stop being claimable (the latest one). */
  waitingUntil: string | null;
};

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/** "3 months to casey · active until Dec 13" and the community variants. */
export function giftPurchaseLine(p: GiftPurchaseView, fmt: DateFormatter = defaultFormat): string {
  // active/ended per recipient was decided by the server against its own clock.
  const latest = p.recipients.reduce<string | null>(
    (acc, r) => (acc == null || new Date(r.expiresAt) > new Date(acc) ? r.expiresAt : acc),
    null
  );
  const anyActive = p.recipients.some((r) => r.active);
  const tail = latest == null ? "" : anyActive ? ` · active until ${fmt(new Date(latest))}` : ` · ended ${fmt(new Date(latest))}`;

  if (p.kind === "direct") {
    const name = p.recipients[0]?.name ?? "someone";
    return `${months(p.months)} to ${name}${tail}`;
  }

  const total = p.recipients.length + p.waiting;
  const waiting =
    p.waiting > 0
      ? `, ${p.waiting} waiting for a new member${p.waitingUntil ? ` (claimable until ${fmt(new Date(p.waitingUntil))})` : ""}`
      : "";
  return `${total} × ${months(p.months)} to the community · ${p.recipients.length} claimed${waiting}${tail}`;
}

/** One gift the viewer received (from /api/billing/gifts). */
export type GiftReceivedView = {
  /** The gifter's name, or null when the gift was anonymous or the account is gone. */
  from: string | null;
  months: number;
  expiresAt: string;
  active: boolean;
};

/** "3 months from casey · active until Dec 13". */
export function giftReceivedLine(r: GiftReceivedView, fmt: DateFormatter = defaultFormat): string {
  // active/ended was decided by the server against its own clock.
  const when = r.active ? `active until ${fmt(new Date(r.expiresAt))}` : `ended ${fmt(new Date(r.expiresAt))}`;
  return `${months(r.months)} from ${r.from ?? "Anonymous"} · ${when}`;
}
