import { stripePublishableKey } from "@/app/lib/stripe";
import { paypalConfigured } from "@/app/lib/paypalClient";
import { instanceString } from "@/app/lib/instanceConfigServer";
import { supporterPrice } from "@/app/lib/supporterPrice";

export const runtime = "nodejs";

// GET /api/billing/stripe/config → { publishableKey: string | null, paypalClientId: string | null, paypalSandbox: boolean,
//                                    supporter: { amount: number, currency: string } | null }
//
// The ONE billing-availability answer the payment surfaces read (useBillingAvailability,
// app/lib/useStripe.ts): which providers this install takes money through, at RUN time — an install
// switches them on its setup pages, so neither can be baked into the build. Both values are public
// by design (Stripe.js and PayPal's SDK need them in the browser). Each is null while its provider
// is switched off or not fully set up; the page opens when either is on. Read at call time, so a
// switch shows on the next request. `no-store`: it changes with a switch.
// `supporter` is the monthly subscription's price as Stripe has it (supporterPrice.ts, cached 10 min):
// null = subscriptions and gifts are not offered here, and the surfaces hide them (R1.10).
// (The path still says "stripe": it is the channel the card surfaces already read; PayPal's id
// joined it rather than keeping a second one.)
export async function GET() {
  const paypalClientId = paypalConfigured() ? (instanceString("paypal.clientId") || null) : null;
  // The sandbox-only SDK parameter (buyer-country) rides on this. The same rule paypalApiBase()
  // uses (anything but "live" is the sandbox), so the SDK and the order API agree on which PayPal.
  const paypalSandbox = paypalClientId !== null && instanceString("paypal.env") !== "live";
  const price = await supporterPrice();
  const supporter = price ? { amount: price.amount, currency: price.currency } : null;
  return Response.json({ publishableKey: stripePublishableKey(), paypalClientId, paypalSandbox, supporter }, { headers: { "Cache-Control": "no-store" } });
}
