// At-rest encryption for the AT Protocol OAuth stores (state + session).
//
// The atproto library persists whole blobs into site.atproto_oauth_state and
// site.atproto_sessions. Those blobs carry LIVE OAuth secrets: the access &
// refresh tokens AND the DPoP private key. Storing them as raw JSONB left them
// in cleartext in Postgres — anyone with DB read could restore a session and
// post to stream.place as the linked account. Encrypt the whole JSON blob with
// the same AES-256-GCM helper used for Matrix tokens (tokenCrypto).
//
// Backward compatible in every direction, mirroring tokenCrypto's rollout so a
// deploy-before-migrate is safe. A stored value coming back from the JSONB
// column is one of three shapes, and unpackSecret handles all of them:
//   1. a parsed object   — legacy plaintext row written before this change
//   2. a "v1:…" string   — encrypted (TOKEN_ENC_KEY configured)
//   3. a JSON-text string — passthrough written when no key is configured
//      (DEV only: in production encToken refuses to run without a key)
// Outside production encToken/decToken are passthrough when TOKEN_ENC_KEY is
// unset, so local dev never stores ciphertext it can't later read.

import { encToken, decToken } from "./tokenCrypto.ts";

/**
 * Serialize an OAuth blob into the value bound to the JSONB column. The inner
 * JSON.stringify makes the blob a string encToken can encrypt; the outer one
 * turns the (possibly "v1:"-prefixed) result into a valid JSON string literal
 * so node-pg stores it as JSONB. In dev with no key configured encToken passes
 * the plaintext through, so the column holds the blob's JSON text as a JSON
 * string; in production a missing key makes this throw (tokenCrypto.ts).
 */
export function packSecret(val: unknown): string {
  return JSON.stringify(encToken(JSON.stringify(val)));
}

/**
 * Reverse packSecret, tolerating all three legacy/current shapes. Returns
 * undefined (the library-store "not found" signal) when a value is missing or a
 * ciphertext can't be decrypted — so the user simply re-authenticates rather
 * than the call throwing.
 */
export function unpackSecret<T>(stored: unknown): T | undefined {
  if (stored == null) return undefined;
  if (typeof stored === "object") return stored as T; // (1) legacy plaintext object
  if (typeof stored !== "string") return undefined;
  const dec = decToken(stored); // (2) "v1:" → plaintext JSON · (3) non-"v1:" passthrough
  if (dec == null) return undefined; // decrypt failed → treat as missing (re-auth)
  try {
    return JSON.parse(dec) as T;
  } catch {
    return undefined;
  }
}
