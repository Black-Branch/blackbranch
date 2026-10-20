// Subscription tiers. Each maps a slug → the Stripe recurring Price ID (created
// in the Stripe dashboard) plus the perks it unlocks. Price IDs come from env so
// test/live keys swap without code changes.
//
// Perks:
//   badge         — unlocks + equips the Subscriber badge and grants a badge slot
//                   (site.badge_unlocks + site.badge_slots, derived live; see v60)
//   usernameColor — unlocks setting a custom username color
//   chatBypass    — relaxed chat rate limit + slow-mode bypass

export type TierSlug = "supporter";

export interface Tier {
  slug: TierSlug;
  name: string;
  priceId: string | undefined; // Stripe Price ID, env-provided
  perks: { badge: boolean; usernameColor: boolean; chatBypass: boolean };
}

export const TIERS: Record<TierSlug, Tier> = {
  supporter: {
    slug: "supporter",
    name: "Supporter",
    priceId: process.env.STRIPE_PRICE_SUPPORTER,
    perks: { badge: true, usernameColor: true, chatBypass: true },
  },
};

export function tierByPriceId(priceId: string | null | undefined): Tier | null {
  if (!priceId) return null;
  return Object.values(TIERS).find((t) => t.priceId === priceId) ?? null;
}

// A subscription's status counts as "entitled to perks" while active or trialing.
// past_due keeps perks until Stripe finally cancels (dunning grace period).
// The single list every SQL status filter must match — presenceServer.ts binds
// it as a query parameter rather than re-typing the three literals a third time.
const ACTIVE_SUB_STATUSES = ["active", "trialing", "past_due"] as const;

export function isActiveStatus(status: string | null | undefined): boolean {
  return (ACTIVE_SUB_STATUSES as readonly string[]).includes(status ?? "");
}
