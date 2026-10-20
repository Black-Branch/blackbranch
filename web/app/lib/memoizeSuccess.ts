// Memoize a promise factory, caching the RESOLVED value ONLY.
//
// Written for `stripeClient.getStripePromise`. With a plain `if (!promise)`
// memo, a viewer whose browser fails to load js.stripe.com once gets
// `loadStripe()`'s rejection handed back for the life of the tab, so every
// later attempt fails without re-trying the network at all.
//
// Such a memo also DEFEATS the library. `@stripe/stripe-js/pure`'s loadScript
// ends with `return stripePromise.catch(e => { stripePromise = null; throw e })`
// and, on the next call, removes and re-injects the <script> tag. Stripe built
// retry in on purpose; caching the rejection on top of it removes it.
//
// So: a rejection clears the cache before it propagates, and the next call runs
// the factory again. Concurrent callers still share one in-flight promise.
export function memoizeSuccess<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = factory().catch((err) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}
