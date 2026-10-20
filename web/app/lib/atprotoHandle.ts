// Validation for AT Protocol handles, applied BEFORE the handle reaches
// @atproto/oauth-client-node's resolver.
//
// WHY. `client.authorize(handle)` resolves the handle to a PDS by querying DNS
// and fetching `https://<handle>/.well-known/atproto-did`. Both are driven by a
// string the user typed, and both happen inside the library — outside our
// safeFetch guard, so they are not covered by the SSRF protections every other
// outbound path uses. We cannot route the library's DNS lookups through
// safeFetch, so the boundary we CAN hold is the input: only ever hand the
// resolver something that is syntactically a public domain name.
//
// This is a narrowing control, not a complete SSRF fix — a real domain can
// still resolve to a private address (rebinding), which only connection-level
// pinning closes. What it does remove is the direct path: IP literals,
// `localhost`, embedded ports, credentials, schemes and paths can no longer
// reach the resolver at all.
//
// Spec: atproto handles are DNS names — ASCII, at least two labels, each label
// 1-63 chars of [a-z0-9-] not starting/ending with '-', total <= 253. The TLD
// may not be all-numeric (that is how an IPv4 literal would sneak through).

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize for comparison/storage: strip a leading '@', trim, lowercase. */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/**
 * True when `handle` is a syntactically valid, public-looking atproto handle.
 * Rejects IP literals, single-label names (localhost), ports, userinfo, schemes
 * and anything carrying a path or query.
 */
export function isValidHandle(handle: string): boolean {
  if (!handle || handle.length > 253) return false;

  // Anything that could carry a scheme, port, credentials, path or query is not
  // a handle. Checked explicitly so these fail for the right reason.
  if (/[:/\\?#@\s]/.test(handle)) return false;

  // Reject a trailing dot (fully-qualified form) rather than silently accepting
  // it — it would make an empty final label.
  const labels = handle.split(".");
  if (labels.length < 2) return false;                  // localhost, or a bare name
  if (!labels.every((l) => LABEL.test(l))) return false;

  // An all-numeric TLD means this is an IPv4 literal (1.2.3.4), not a domain.
  const tld = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(tld)) return false;

  return true;
}
