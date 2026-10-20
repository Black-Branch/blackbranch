import { loadStripe } from "@stripe/stripe-js/pure";
// Type-only import — erased at compile time, so it does NOT evaluate the root
// module or re-introduce the eager-script side effect the `/pure` value import
// avoids. `/pure` doesn't re-export the `Stripe` type, hence the split. Don't
// merge these back into one import from the root.
import type { Stripe } from "@stripe/stripe-js";
import { memoizeSuccess } from "./memoizeSuccess";

// Client-side Stripe.js loader for Embedded Checkout. The publishable key is a
// NEXT_PUBLIC_ var (safe to expose — it's public by design) and is inlined at
// build time, so it must be present when `npm run build` runs, not just at
// runtime.
//
// Import from `@stripe/stripe-js/pure`, NOT the package root. The root entry
// injects the remote js.stripe.com/dahlia/stripe.js (~244KB gzip) as a
// module-eval side effect — and because StreamView imports the boolean
// `stripePublishableConfigured` below, that would pull the script onto EVERY
// page load (home/offline/radio), for signed-out viewers who never open a
// payment flow. The `/pure` entry defers the script injection until the first
// `loadStripe()` call (i.e. a Store/Support modal actually mounting).

// memoizeSuccess, NOT a plain `if (!promise)` memo. A rejection must clear the
// cache so the next call genuinely re-attempts the script — otherwise a viewer
// whose js.stripe.com load was blocked once stays blocked for the life of the
// tab even though @stripe/stripe-js is built to retry. Callers must handle the
// rejection: useStripe() does, and it is the only sanctioned way to consume
// this.
// The key the server named at run time (an install sets it on the Stripe setup page, not in its
// build). useBillingAvailability() records it before any card form can mount.
let runtimeKey: string | null = null;
export function setStripePublishableKey(key: string | null): void {
  runtimeKey = key;
}

const loadOnce = memoizeSuccess<Stripe | null>(() => {
  const pk = runtimeKey ?? process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  // No key baked into this build. Resolve null rather than calling loadStripe,
  // which throws on a non-string publishable key; stripePublishableConfigured()
  // is the gate that stops the UI reaching here at all.
  return pk ? loadStripe(pk) : Promise.resolve(null);
});

export function getStripePromise(): Promise<Stripe | null> {
  return loadOnce();
}

// True when the client publishable key was baked into this build — the FIRST answer of
// useBillingAvailability() (so a build that has it paints the card UI at once); the server's answer
// follows. Components gate on useBillingAvailability(), never on this alone.
export function stripePublishableConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}
