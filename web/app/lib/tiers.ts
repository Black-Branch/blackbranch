// Subscription tiers. Each maps a slug → the Stripe recurring Price ID (created
// in the Stripe dashboard) plus the perks it unlocks. The Price ID is the setting
// stripe.supporterPriceId (Admin Panel → Stripe; env STRIPE_PRICE_SUPPORTER is its
// install-tier fallback), read at call time like every other setting — so test/live
// prices swap without a restart. What it costs is read from Stripe (supporterPrice.ts).
//
// Perks:
//   badge         — unlocks + equips the Subscriber badge and grants a badge slot
//                   (site.badge_unlocks + site.badge_slots, derived live; see v60)
//   usernameColor — unlocks setting a custom username color
//   chatBypass    — relaxed chat rate limit + slow-mode bypass

import { instanceString } from "./instanceConfigServer.ts";

export type TierSlug = "supporter";

export interface Tier {
  slug: TierSlug;
  name: string;
  /** Order among tiers: a viewer holding several subscriptions is at the HIGHEST rank any of them
   *  gives (subscription sources, spec §3.2). One tier today, so it changes no answer. */
  rank: number;
  /** Stripe Price ID, from the setting; undefined while unset. */
  readonly priceId: string | undefined;
  perks: { badge: boolean; usernameColor: boolean; chatBypass: boolean };
}

export const TIERS: Record<TierSlug, Tier> = {
  supporter: {
    slug: "supporter",
    name: "Supporter",
    rank: 1,
    get priceId() { return instanceString("stripe.supporterPriceId")?.trim() || undefined; },
    perks: { badge: true, usernameColor: true, chatBypass: true },
  },
};

/** Every tier slug, lowest rank first. The slug list is PRODUCT code: an install maps its services'
 *  tiers onto it, it does not invent slugs. */
const TIER_ORDER: readonly TierSlug[] = (Object.values(TIERS) as Tier[])
  .sort((a, b) => a.rank - b.rank)
  .map((t) => t.slug);

/** The highest-ranked of `slugs` by `order` (lowest first); null when none is a known tier. Pure —
 *  `order` is a parameter so a test can rank a second, test-only tier. */
export function highestTier<S extends string = TierSlug>(slugs: readonly (string | null | undefined)[], order: readonly S[] = TIER_ORDER as readonly S[]): S | null {
  let best = -1;
  for (const s of slugs) best = Math.max(best, order.indexOf(s as S));
  return best >= 0 ? order[best]! : null;
}

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
