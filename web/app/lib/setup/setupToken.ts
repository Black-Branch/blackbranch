// The setup link's token. SERVER ONLY.
//
// The host keeps the token (root-only) so `blackbranch setup-link` can print it again; the site gets
// only its sha256 as SETUP_TOKEN_HASH. The token works until the first admin exists — the caller
// checks that, so the hash alone never decides.

import { createHash, timingSafeEqual } from "node:crypto";

/** Is `token` the one whose sha256 is `hash`? Constant-time; false for anything malformed. */
export function setupTokenMatches(token: unknown, hash: string | undefined = process.env.SETUP_TOKEN_HASH): boolean {
  if (typeof token !== "string" || !/^[0-9a-f]{16,128}$/.test(token)) return false;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const got = createHash("sha256").update(token).digest();
  return timingSafeEqual(got, Buffer.from(hash, "hex"));
}

/** Does this install have a setup link at all? */
export function setupLinkConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return /^[0-9a-f]{64}$/.test(env.SETUP_TOKEN_HASH ?? "");
}

/** May the link create the first admin now? Only with the right token, and only while no admin
 *  exists — after that it is dead, whoever holds it. */
export function setupLinkUsable(input: { tokenOk: boolean; adminExists: boolean }): boolean {
  return input.tokenOk && !input.adminExists;
}
