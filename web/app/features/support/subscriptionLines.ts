// The words the Support panel shows about a viewer's subscriptions, one line per service
// (subscription sources, spec §10.1, §10.2) — pure functions of /api/me's `subscriptions` and a
// clock, so the copy is tested against fixed dates (subscriptionLines.test.ts).

/** One record as /api/me lists it (subscriptions/entitlement.ts listViewerSubscriptions). */
export type SubscriptionRecordView = {
  provider: string;
  tier: string | null;
  status: string;
  renews: boolean;
  periodEnd: string | null;
  accessUntil: string | null;
};

type Fmt = (d: Date) => string;
const defaultFmt: Fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

const SERVICE: Record<string, string> = { stripe: "Card", paypal: "PayPal", patreon: "Patreon", kofi: "Ko-fi", twitch: "Twitch", kick: "Kick" };
/** How "Supporter through …" names a service. */
const THROUGH: Record<string, string> = { stripe: "a card subscription", paypal: "PayPal" };

export function serviceName(provider: string): string {
  return SERVICE[provider] ?? provider;
}

/** Still a subscription the viewer holds: entitling now, paused by the service, or approved and
 *  waiting for its first payment. An ended one, or one whose access ran out, is not. */
export function isLiveRecord(r: SubscriptionRecordView, now: Date = new Date()): boolean {
  if (r.status === "active" || r.status === "past_due") return !r.accessUntil || new Date(r.accessUntil).getTime() > now.getTime();
  if (r.status === "paused") return true;
  return r.status === "pending" && r.renews;
}

/** "Active · renews Nov 3" and its siblings for one live record; null for one not to show. */
export function recordLine(r: SubscriptionRecordView, now: Date = new Date(), fmt: Fmt = defaultFmt): { service: string; text: string; ending: boolean } | null {
  if (!isLiveRecord(r, now)) return null;
  const service = serviceName(r.provider);
  const end = r.renews ? r.periodEnd : r.accessUntil ?? r.periodEnd;
  const on = end ? fmt(new Date(end)) : null;
  const paypal = r.provider === "paypal";
  if (r.status === "pending") return { service, text: paypal ? "Waiting for PayPal to confirm the first payment" : "Waiting for the first payment", ending: false };
  if (r.status === "paused") return { service, text: paypal ? "Paused by PayPal" : "Paused", ending: true };
  if (r.status === "past_due") return { service, text: paypal ? "PayPal is retrying a payment" : "Payment due", ending: true };
  if (!r.renews) return { service, text: on ? `Ends ${on}` : "Renewal is off", ending: true };
  return { service, text: on ? `Active · renews ${on}` : "Active", ending: false };
}

/** The "you'd be paying twice" warning (§10.1), shown before any payment starts. */
export function elsewhereWarning(e: { provider: string; periodEnd: string | null }, fmt: Fmt = defaultFmt): string {
  const through = THROUGH[e.provider] ?? serviceName(e.provider);
  const renews = e.periodEnd ? ` (renews ${fmt(new Date(e.periodEnd))})` : "";
  return `You’re already a Supporter through ${through}${renews}. Subscribing here is a second, separate subscription — you’d be paying twice.`;
}
