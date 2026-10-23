// The Subscribe button under the player: whether it shows, and whether it opens the Support panel
// in place or the site's outside subscribe link (money.subscribeUrl). Pure; StreamView calls it
// with useBillingAvailability's answer on every render.
//
// Subscriptions exist when EITHER provider sells them (k, 2026-10-21): `subscribe` is the server's
// one answer to that (Stripe's Supporter price, or a PayPal plan PayPal prices). The button opens
// the Support panel on its subscribe view, and the panel shows the providers that are set.
// A viewer who already subscribes sees Gift on the same button, and a gift is a card checkout, so
// that needs Stripe's own price (`stripe` and `supporter`), as it always did.
import type { BillingAvailability } from "@/app/lib/useStripe";

export function subscribeButton(a: {
  billing: Pick<BillingAvailability, "stripe" | "supporter" | "subscribe">;
  subscribed: boolean;
  /** money.subscribeUrl, "" when unset. */
  outsideUrl: string;
}): { shown: boolean; inPlace: boolean } {
  const giftsOn = a.billing.stripe && a.billing.supporter !== null;
  const inPlace = a.subscribed ? giftsOn : a.billing.subscribe !== null;
  return { shown: inPlace || a.outsideUrl !== "", inPlace };
}
