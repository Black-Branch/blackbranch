// Pure gift pricing/constants — safe to import from both client and server (no DB).

const GIFT_PRICE_CENTS_PER_MONTH = 500; // $5/mo, same as the subscription
export const GIFT_MONTHS = [1, 3, 6, 12] as const;
export type GiftMonths = (typeof GIFT_MONTHS)[number];
export const MAX_COMMUNITY = 50; // most random recipients per community gift

export function isGiftMonths(m: number): m is GiftMonths {
  return (GIFT_MONTHS as readonly number[]).includes(m);
}

export function giftAmountCents(months: number, count: number): number {
  return GIFT_PRICE_CENTS_PER_MONTH * months * count;
}
