// Pure gift pricing/constants — safe to import from both client and server (no DB).
// A gift month costs what a Supporter month costs: the Stripe Price the install names
// (supporterPrice.ts), never a number written here.

export const GIFT_MONTHS = [1, 3, 6, 12] as const;
export type GiftMonths = (typeof GIFT_MONTHS)[number];
export const MAX_COMMUNITY = 50; // most random recipients per community gift

export function isGiftMonths(m: number): m is GiftMonths {
  return (GIFT_MONTHS as readonly number[]).includes(m);
}

/** The total, in the subscription price's minor units: one month's price × months × recipients. */
export function giftAmountMinor(monthlyMinor: number, months: number, count: number): number {
  return monthlyMinor * months * count;
}
