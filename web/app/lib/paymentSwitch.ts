// Switching a payment provider off: the save route refuses it while that provider entitles anyone,
// unless the request confirms the count the panel showed; the panel asks with these words.
// Universal (the route and KeyCards both read it), no imports beyond types.
//
// Why: entitlement counts only providers whose module is on (subscriptions/entitlement.ts
// subscriptionSources), so switching Stripe or PayPal off ends their subscribers' Supporter perks at
// once while the provider keeps charging them. Whether it should is k's Q1; the default is no change
// to entitlement, and the switch names the count and what to cancel first.
import type { Provider } from "./subscriptions/types.ts";

type PaymentProvider = Extract<Provider, "stripe" | "paypal">;

const SWITCHES: Record<string, PaymentProvider> = { "modules.stripe": "stripe", "modules.paypal": "paypal" };

const NAME: Record<PaymentProvider, string> = { stripe: "Stripe", paypal: "PayPal" };

/** Where the streamer cancels a provider's subscriptions. */
const CANCEL_AT: Record<PaymentProvider, string> = {
  stripe: "Stripe Dashboard → Billing → Subscriptions",
  paypal: "your PayPal Business account → Pay & Get Paid → Subscriptions",
};

/** The provider a save switches OFF, or null when it is anything else. */
export function paymentSwitchOff(key: string, value: unknown): PaymentProvider | null {
  return value === false ? SWITCHES[key] ?? null : null;
}

/** The provider a "Clear saved" may switch OFF: a payment switch that is on now. Clearing removes the
 *  stored value and the switch falls back to its default, which is off on a new install. */
export function paymentSwitchClear(key: string, onNow: boolean): PaymentProvider | null {
  return onNow ? SWITCHES[key] ?? null : null;
}

/** The count a confirmed DELETE carries (`?confirm=N`; a DELETE sends no body). */
export function paymentConfirmParam(url: URL): number | undefined {
  const raw = url.searchParams.get("confirm");
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
}

/** The route's 409 body, or null when the switch-off may be saved: nobody to warn about, or the
 *  request confirmed exactly the count running now. */
export function paymentSwitchRefusal(provider: PaymentProvider, running: number, confirmed: unknown) {
  if (running <= 0 || confirmed === running) return null;
  return { error: "confirm_payment_switch", needConfirm: true as const, provider, count: running };
}

/** What the panel asks before it confirms. */
export function paymentSwitchWarning(provider: PaymentProvider, count: number): string {
  const name = NAME[provider];
  const who = `${count} subscriber${count === 1 ? "" : "s"}`;
  return `${who} pay${count === 1 ? "s" : ""} for Supporter through ${name}. Switching ${name} off means their perks end now, `
    + `and ${name} keeps charging them until you cancel their subscriptions at ${name} (${CANCEL_AT[provider]}). `
    + `Cancel them there first. Switch ${name} off anyway?`;
}
