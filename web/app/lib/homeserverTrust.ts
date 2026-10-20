// "Is this URL on OUR homeserver?" — the trust decision for server-side fetches built on a
// session's stored homeserver. Kept dependency-free (matrixConfig → installValues only) so the
// predicate is testable under node --test (the transport wrapper in homeserverFetch.ts imports
// ssrf/undici, which the test runner can't load).
//
// PARSED ORIGINS, never string prefixes. A `url.startsWith(base + "/")` check is safe only while
// the base has no trailing slash: a configured `https://matrix.example.tv/` would double the slash
// and silently lose the fast path, and every safety property would rest on that one character.
// Comparing `new URL(u).origin` makes the decision the URL parser's, which is the same parser
// fetch uses.

import { matrixBaseUrl } from "./matrixConfig.ts";

/** The origin (scheme + host + port, host lower-cased) of a URL, or null when it does not parse
 *  or carries credentials — a URL with userinfo is never trusted, whatever its host. */
function originOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u.origin;
}

/** Two URLs on the same origin (both must parse, neither may carry credentials). */
export function sameOrigin(a: string, b: string): boolean {
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}

/** True only for URLs on this install's homeserver origin (`matrix.baseUrl`). `local` is the
 *  configured base; tests pass their own. An unset base trusts nothing. */
export function isLocalHomeserverUrl(url: string, local: string = matrixBaseUrl()): boolean {
  return local !== "" && sameOrigin(url, local);
}
