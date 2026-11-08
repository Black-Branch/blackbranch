// The fetch the atproto OAuth client makes every request with: handle and DID resolution, OAuth
// metadata, PAR and token calls, and the PDS session that posts to stream.place.
//
// Those URLs and bodies come from servers a signed-in user can run — a handle that resolves to
// did:web:<their domain> makes the site fetch and parse what that domain serves — so the plain
// globalThis.fetch the client falls back to is not safe: no size limit (a huge body, parsed and
// validated with zod, can exhaust the web process's memory) and no address policy (a DID or
// metadata URL can point at the LAN). This wrapper refuses non-https URLs and private, loopback
// and link-local addresses on every redirect hop, stops reading a body past 512 kB, and gives
// the whole request 10 s.
import { safeFetchWrap } from "@atproto-labs/fetch-node";

const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

// The address policy is enforced by the undici `dispatcher` the wrapper adds to each request. Inside
// the Next server, globalThis.fetch is Next's patched fetch, and in a request context it rebuilds a
// Request from a fixed field list that drops `dispatcher` — every private address would then be
// fetched. A fetch marked `next.internal` is passed to the underlying fetch untouched (patch-fetch
// and its dedupe layer), so the inner fetch marks every call. Resolved per call: Next patches the
// global when the server starts, which may be after this module loads.
const nextInternalFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, next: { ...init?.next, internal: true } } as RequestInit);

/**
 * The wrapper around a given inner fetch.
 * @test-only the tests inject an inner fetch to observe what the wrapper lets through
 */
export function makeAtprotoFetch(inner: typeof globalThis.fetch = nextInternalFetch): typeof globalThis.fetch {
  return safeFetchWrap({
    fetch: inner,
    responseMaxSize: MAX_RESPONSE_BYTES,
    timeout: TIMEOUT_MS,
    ssrfProtection: true,
    // The OAuth client's DPoP wrapper hands fetch a bare Request (PAR, token, PDS calls), which the
    // default refuses outright. The address policy still applies to every hop the request takes.
    allowImplicitRedirect: true,
  }) as typeof globalThis.fetch;
}

export const atprotoFetch = makeAtprotoFetch();
