// Stripe → subscription record: the Stripe adapter's mapping (subscription sources, spec §3.3, §5.1).
//
// Pure. The reconciler (subscriptionSync.ts) lists every subscription of every customer a viewer
// has had, under the viewer's lock, and hands each one here; the transition function
// (subscriptions/state.ts) writes what comes back. Nothing here reads the event's own body.
import type Stripe from "stripe";
import { tierByPriceId } from "../tiers.ts";
import type { NormalStatus, Observation } from "./types.ts";
import { withGrace } from "./grace.ts";

/** Stripe's status in the spec's normalised words. Keeps today's entitled set exactly: `active`,
 *  `trialing` and `past_due` are the three that entitle (tiers.ts isActiveStatus). migrate-v161.sql's
 *  back-fill carries the same mapping as SQL; backfill.test.ts holds the two equal.
 *  @test-only exported so backfill.test.ts can compare it with the migration's SQL; stripeObservation
 *  (this file) is its caller. */
export function normaliseStripeStatus(status: string | null | undefined): NormalStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "incomplete":
      return "pending";
    case "unpaid":
    case "paused":
      return "paused";
    default:
      return "ended";
  }
}

/** The current period's end (unix seconds), or null. current_period_end moved from the Subscription
 *  to its items across API versions — the same defensive read as subscriptionSync.ts's writeState. */
function currentPeriodEnd(sub: Pick<Stripe.Subscription, "items">): number | null {
  return (
    (sub.items?.data[0] as { current_period_end?: number } | undefined)?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    null
  );
}

/** Has the viewer switched renewal off? Stripe says so two ways: the older `cancel_at_period_end`
 *  flag, and `cancel_at` (+ `canceled_at`), which the newer customer portal's "cancel at period end"
 *  sets while leaving `cancel_at_period_end` FALSE (2026-10-21: a viewer who cancelled was told
 *  "Renews on Oct 26"). A `cancel_at` counts only when it falls at or before the current period's
 *  end — a cancellation scheduled beyond it still renews once first (design review 2026-10-22); with
 *  no period end to compare, a scheduled cancellation reads as renewal off. The record mapping
 *  (below) and the legacy row's writer (subscriptionSync.ts) both read this, so the two never
 *  disagree. */
export function stripeRenewalOff(sub: Pick<Stripe.Subscription, "cancel_at_period_end" | "cancel_at" | "items">): boolean {
  if (sub.cancel_at_period_end) return true;
  if (sub.cancel_at == null) return false;
  const cpe = currentPeriodEnd(sub);
  return cpe == null || sub.cancel_at <= cpe;
}

/** Does the reconciler need this subscription's payment history? Only for a past_due subscription
 *  that began with a trial (a card bought during a gift — checkout's trial_end): it may never have
 *  been paid at all, and past_due entitles. */
export function needsPaymentHistory(sub: Pick<Stripe.Subscription, "status" | "trial_end">): boolean {
  return sub.status === "past_due" && sub.trial_end != null;
}

/** A trial is not a payment (security review 2026-10-22). A past_due subscription that came out of
 *  a trial with no successful NON-ZERO paid invoice (the trial's own $0 invoice does not count) has
 *  never been paid for: it is read as `incomplete` — never entitles, no grace days — by the record
 *  mapping, the legacy row, the badge and /api/me alike. `paidAmounts` = amount_paid of the
 *  subscription's paid invoices; null when they were not looked up (needsPaymentHistory false).
 *  Once a charge succeeds Stripe moves the subscription to active, and every rule is as before. */
export function settleNeverPaid(sub: Stripe.Subscription, paidAmounts: readonly number[] | null): Stripe.Subscription {
  if (!needsPaymentHistory(sub)) return sub;
  if ((paidAmounts ?? []).some((a) => a > 0)) return sub;
  return { ...sub, status: "incomplete" };
}

const customerOf = (s: Stripe.Subscription) => (typeof s.customer === "string" ? s.customer : s.customer.id);

/** A subscription Stripe no longer has (`resource_missing` on its retrieve — deleted, or the keys
 *  now point at another Stripe account): it charges no one, so its record ends. Never entitles. */
export function missingStripeObservation(externalId: string, observedAt: Date): Observation {
  return {
    provider: "stripe", externalId, tier: null, status: "ended", providerStatus: "missing",
    renews: false, periodEnd: null, accessUntil: null, observedAt,
  };
}

/** One Stripe subscription as an observation, stamped with the Event's `created` (the stamp
 *  today's recency gate already uses). The tier is the subscription's price mapped by the setting;
 *  a price the install does not sell maps to no tier, which never entitles — the same answer
 *  getActiveTier gave it before. */
export function stripeObservation(sub: Stripe.Subscription, observedAt: Date): Observation {
  const cpe = currentPeriodEnd(sub);
  const periodEnd = cpe ? new Date(cpe * 1000) : null;
  return {
    provider: "stripe",
    externalId: sub.id,
    tier: tierByPriceId(sub.items.data[0]?.price?.id ?? null)?.slug ?? null,
    status: normaliseStripeStatus(sub.status),
    providerStatus: sub.status,
    renews: !stripeRenewalOff(sub),
    periodEnd,
    // The period end plus the grace days (§3.4; security review 2026-10-21, finding 4). Stripe
    // does send the end — but a customer.subscription.deleted lost for good (the webhook down, or
    // the Stripe module off, past Stripe's ~3 days of retries) used to leave access open for ever.
    // Every renewal moves the period end, and with it this.
    // A trialing subscription's period end is the trial's end, which nobody has paid for: no grace.
    accessUntil: sub.status === "trialing" ? periodEnd : withGrace(periodEnd),
    accountRef: customerOf(sub),
    observedAt,
  };
}
