// A subscription RENEWAL, read off a Stripe `invoice.paid` event.
//
// Why this exists: a renewal reaches the webhook only as
// `customer.subscription.updated` with announce=false — no card, no
// stream.support_events row, no bar credit — so the site's own recurring
// income would be invisible while Twitch resubs are counted. `invoice.paid` is
// the event that says money moved for a cycle.
//
// The guards are the whole point, so they live in a pure function the tests
// can RUN (the webhook route imports pg and Stripe at load and cannot be):
//   • billing_reason === "subscription_cycle" ONLY. The first invoice is
//     `subscription_create` and is already celebrated + credited by
//     `customer.subscription.created` — taking it here would credit the bar
//     twice for one payment. `subscription_update` is a proration on a change,
//     not a renewal, and there is one tier anyway.
//   • amount_paid > 0 — a 100%-coupon or $0 cycle funds nothing.
//   • the subscription id must be present (Stripe API 2025-03+ moved it to
//     `parent.subscription_details`).

/** The slice of Stripe.Invoice this module reads — structural, so a test can
 *  pass a literal and the route can pass the real object. */
type RenewalInvoiceLike = {
  id: string;
  billing_reason: string | null;
  amount_paid: number;
  currency: string;
  customer: string | { id: string } | null;
  parent: { subscription_details: { subscription: string | { id: string } } | null } | null;
};

type Renewal = {
  invoiceId: string;
  subscriptionId: string;
  customerId: string | null;
  /** Gross paid for the cycle, in the invoice's minor unit (cents). */
  amount: number;
  currency: string;
};

/** The renewal an invoice represents, or null when it is not a renewal. */
export function renewalFromInvoice(inv: RenewalInvoiceLike): Renewal | null {
  if (inv.billing_reason !== "subscription_cycle") return null;
  if (!(inv.amount_paid > 0)) return null;
  const s = inv.parent?.subscription_details?.subscription;
  const subscriptionId = typeof s === "string" ? s : s?.id;
  if (!subscriptionId) return null;
  const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  return { invoiceId: inv.id, subscriptionId, customerId, amount: inv.amount_paid, currency: inv.currency };
}

/**
 * Months subscribed, from the count of paid invoices on the subscription. A
 * cycle invoice means at least two have been paid (the first + this one), so
 * a short or failed listing floors there rather than announcing "1 month" on
 * a renewal.
 *
 * `trialed`: the subscription began with a trial (a card bought during a gift —
 * checkout's trial_end). Its first invoice is a $0 trial invoice that Stripe
 * marks paid, and its first REAL charge is a subscription_cycle invoice — so
 * the trial invoice is not a month, and a cycle invoice means at least one.
 */
export function tenureMonths(paidInvoiceCount: number, trialed = false): number {
  const n = Math.floor(paidInvoiceCount) || 0;
  return trialed ? Math.max(1, n - 1) : Math.max(2, n);
}
