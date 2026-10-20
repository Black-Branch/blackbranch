// Transport for URLs built on a session's stored homeserver / OIDC endpoint.
// Our own homeserver is a constant, trusted target and keeps plain fetch (the
// media proxy is hot — connection reuse, no per-request DNS validation). Any
// OTHER base is user-influenced federation data (persisted at login from the
// MXID's own .well-known, per the matrix-callback guard), so it goes through
// safeFetch, which validates and PINS every hop — including redirects, which a
// hostile homeserver could otherwise use to steer a token-attached server-side
// fetch at internal addresses: the login-time guard only validates the endpoint
// itself, not where it 3xx's to at use time.
//
// BOTH branches carry the same deadline (ssrf.ts FETCH_DEADLINE_MS, or the caller's `timeoutMs`),
// and it covers reading the body: our own server is trusted, not infallible, and one that sends
// headers and then stalls would otherwise hold every reader waiting on it.

import { safeFetch, deadlineSignal, FETCH_DEADLINE_MS, type FetchInit } from "./ssrf.ts";
import { isLocalHomeserverUrl } from "./homeserverTrust.ts";

export function homeserverFetch(url: string, init: FetchInit = {}): Promise<Response> {
  if (!isLocalHomeserverUrl(url)) return safeFetch(url, init);
  const { timeoutMs, signal, ...rest } = init;
  return fetch(url, { ...rest, signal: deadlineSignal(signal, timeoutMs ?? FETCH_DEADLINE_MS) });
}
