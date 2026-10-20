import crypto from "crypto";

// OAuth PKCE (RFC 7636) + random-token helpers for the three initiate routes
// (matrix-initiate, mas-initiate, link/[platform]/initiate), which previously
// each hand-rolled the same base64url + SHA-256 derivation — including the
// same `as unknown as Buffer` typing workaround, three times. Calling
// .toString("base64url") on the digest directly needs no cast at all.

/** `bytes` random bytes as a base64url string (state values, verifiers). */
export function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** A fresh PKCE pair: verifier = 32 random bytes base64url, challenge =
 * base64url(SHA-256(verifier)) — the S256 code_challenge_method. */
export function pkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomToken(32);
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest().toString("base64url");
  return { codeVerifier, codeChallenge };
}
