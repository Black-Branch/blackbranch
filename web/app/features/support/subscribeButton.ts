// The Subscribe button under the player: whether it shows, and whether it opens the Support panel
// in place or the site's outside subscribe link (money.subscribeUrl). Pure; StreamView calls it
// with useBillingAvailability's answer on every render.
//
// Subscriptions exist when EITHER provider sells them (k, 2026-10-21): `subscribe` is the server's
// one answer to that (Stripe's Supporter price, or a PayPal plan PayPal prices). The button opens
// the Support panel on its subscribe view, and the panel shows the providers that are set.
// A viewer who already subscribes sees Gift on the same button, and a gift is a card checkout, so
// that needs Stripe's own price (`stripe` and `supporter`), as it always did. Where gifts cannot be
// sold but the site still sells the subscription (PayPal only), a subscriber sees "Subscribed",
// opening the same page, which shows them their subscription (k-questions Q4 default, W-08).
import type { BillingAvailability } from "@/app/lib/useStripe";

export function subscribeButton(a: {
  billing: Pick<BillingAvailability, "stripe" | "supporter" | "subscribe">;
  subscribed: boolean;
  /** money.subscribeUrl, "" when unset. */
  outsideUrl: string;
}): { shown: boolean; inPlace: boolean; label: "subscribe" | "gift" | "subscribed" } {
  const giftsOn = a.billing.stripe && a.billing.supporter !== null;
  const sells = a.billing.subscribe !== null;
  if (a.subscribed && !giftsOn && sells) return { shown: true, inPlace: true, label: "subscribed" };
  const inPlace = a.subscribed ? giftsOn : sells;
  return { shown: inPlace || a.outsideUrl !== "", inPlace, label: a.subscribed ? "gift" : "subscribe" };
}
