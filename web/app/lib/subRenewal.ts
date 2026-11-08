// A paid subscription invoice, read off a Stripe `invoice.paid` event: the event that says money
// moved for a subscription, and so the ONE source of every "subscribed" / "resubscribed" card and
// the bar credit it carries (subscriptionSync.ts paidInvoiceCard builds the card from this).
//
// Why the invoice and not the subscription's state events: Stripe does not order deliveries, and
// the per-viewer recency gate drops a state event stamped older than the last one written. A first
// month credited from `customer.subscription.created` was lost whenever that event lost the race.
// An invoice is paid once; its spendId is fixed by what it is, so any delivery order credits it
// exactly once (stream-api's ledger dedups on the spendId).
//
// The guards live in a pure function the tests can RUN (the webhook route imports pg and Stripe at
// load and cannot be):
//   • billing_reason "subscription_create" = month one (spendId `sub:<subscription id>`, the id the
//     refund path recomputes — paymentReversalsLedger.ts); "subscription_cycle" = a renewal
//     (spendId `renewal:<invoice id>`). `subscription_update` is a proration on a change, not a
//     month, and there is one tier anyway.
//   • amount_paid > 0 — a trial's $0 first invoice, a 100%-coupon or a $0 cycle funds nothing.
//   • the subscription id must be present (Stripe API 2025-03+ moved it to
//     `parent.subscription_details`).

/** The slice of Stripe.Invoice this module reads — structural, so a test can
 *  pass a literal and the route can pass the real object. */
type PaidInvoiceLike = {
  id: string;
  billing_reason: string | null;
  amount_paid: number;
  currency: string;
  customer: string | { id: string } | null;
  parent: { subscription_details: { subscription: string | { id: string } } | null } | null;
};

type PaidSubscriptionInvoice = {
  /** "first" = the subscription's first paid invoice; "renewal" = a later cycle. */
  kind: "first" | "renewal";
  invoiceId: string;
  subscriptionId: string;
  customerId: string | null;
  /** Gross paid, in the invoice's minor unit (cents). */
  amount: number;
  currency: string;
};

/** The paid month an invoice represents, or null when it funds no month. */
export function paidSubscriptionInvoice(inv: PaidInvoiceLike): PaidSubscriptionInvoice | null {
  const kind = inv.billing_reason === "subscription_create" ? "first" : inv.billing_reason === "subscription_cycle" ? "renewal" : null;
  if (!kind) return null;
  if (!(inv.amount_paid > 0)) return null;
  const s = inv.parent?.subscription_details?.subscription;
  const subscriptionId = typeof s === "string" ? s : s?.id;
  if (!subscriptionId) return null;
  const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
  return { kind, invoiceId: inv.id, subscriptionId, customerId, amount: inv.amount_paid, currency: inv.currency };
}

/**
 * Months subscribed at a renewal, from the count of paid invoices on the subscription. A
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
