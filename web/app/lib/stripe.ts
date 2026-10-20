import Stripe from "stripe";
import { installValue } from "./installValues.ts";
import { instanceBool, instanceString } from "./instanceConfigServer.ts";

// Server-only Stripe client. STRIPE_SECRET_KEY lives in web/.env.local (a test
// key in dev, the live key in prod). NEVER import this from a client component.
//
// Constructed lazily so a missing key surfaces a clear error at call time rather
// than crashing the whole server (or the build) on import. apiVersion is left
// unset so the SDK uses its bundled default — pinning a wrong literal throws. The
// Stripe setup page names that default for the webhook destination; stripeApiVersion.test.ts
// holds the two equal.

// Keyed by the secret it was made with: a key saved in the Admin Panel applies at the next call,
// like every other setting the website reads, rather than at the next restart.
let _stripe: { key: string; client: Stripe } | null = null;

export function getStripe(): Stripe {
  const key = instanceString("stripe.secretKey");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  // Bounded, not the SDK defaults: the defaults are an 80s timeout × 2
  // retries, and these calls sit inside request paths (checkout, webhook
  // retrieves). A Stripe stall on defaults holds a route open for minutes;
  // 15s × 1 retry fails fast enough for the caller's own error copy to still
  // mean something. apiVersion stays unset on purpose (see above).
  if (_stripe?.key !== key) _stripe = { key, client: new Stripe(key, { timeout: 15_000, maxNetworkRetries: 1 }) };
  return _stripe.client;
}

/** The card-payments module switch (config/modules.mjs `stripe`). Off = no checkout, and the
 *  webhook route answers 404 so Stripe keeps the event and retries it (about three days). */
export function stripeModuleOn(): boolean {
  return instanceBool("modules.stripe");
}

export function stripeConfigured(): boolean {
  return stripeModuleOn() && Boolean(instanceString("stripe.secretKey"));
}

/** The publishable key the browser's card form uses: the setting, or (an older build) the
 *  NEXT_PUBLIC_ value baked in. null while Stripe is off or has no key. */
export function stripePublishableKey(): string | null {
  if (!stripeConfigured()) return null;
  return instanceString("stripe.publishableKey") || process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || null;
}

// Public origin for Stripe redirect URLs (success/cancel/return). Behind the
// Cloudflare tunnel, req.nextUrl.origin resolves to the internal bind address
// (0.0.0.0:3000), so prefer the site's own origin (install key site.origin, as
// built); the request origin is only a fallback for a build that has none.
export function publicOrigin(fallback: string): string {
  return installValue("site.origin") || fallback;
}
