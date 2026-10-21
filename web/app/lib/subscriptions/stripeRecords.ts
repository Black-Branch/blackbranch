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
  // current_period_end moved from the Subscription to its items across API versions (the same
  // defensive read as subscriptionSync.ts's writeState).
  const cpe =
    (sub.items.data[0] as { current_period_end?: number } | undefined)?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;
  const periodEnd = cpe ? new Date(cpe * 1000) : null;
  return {
    provider: "stripe",
    externalId: sub.id,
    tier: tierByPriceId(sub.items.data[0]?.price?.id ?? null)?.slug ?? null,
    status: normaliseStripeStatus(sub.status),
    providerStatus: sub.status,
    renews: !sub.cancel_at_period_end,
    periodEnd,
    // The period end plus the grace days (§3.4; security review 2026-10-21, finding 4). Stripe
    // does send the end — but a customer.subscription.deleted lost for good (the webhook down, or
    // the Stripe module off, past Stripe's ~3 days of retries) used to leave access open for ever.
    // Every renewal moves the period end, and with it this.
    accessUntil: withGrace(periodEnd),
    accountRef: customerOf(sub),
    observedAt,
  };
}
