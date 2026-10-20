// A person's PUBLIC id on one platform — what the public chat history, the profile card and every
// other public surface use in place of the canonical stream id (config/public-id.mjs has the why
// and the construction). The same key as stream-api's (both derive it from STREAM_API_SECRET), so
// an id on the live socket and the same person's id in the history are one id, and this server
// reads either back to the canonical.
//
// SERVER ONLY: it holds the key. A client never makes or reads a public id; it only compares them.
import crypto from "node:crypto";
import { PUBLIC_ID } from "./publicId.generated.mjs";
import { ERASED_CANONICAL } from "./erasedPerson.ts";

type Keys = { mac: Buffer; enc: Buffer };
let keys: Keys | null = null;

function currentKeys(): Keys {
  if (keys) return keys;
  const secret = process.env.STREAM_API_SECRET ?? "";
  if (!secret) {
    console.warn("[public-id] STREAM_API_SECRET unset — public ids use a key of this process only (stream-api's cannot be read)");
  }
  keys = PUBLIC_ID.keys(crypto, secret || crypto.randomBytes(32).toString("hex"));
  return keys;
}

/** The public id of `canonical` on `platform`; null for no canonical and for the erased-person row. */
export function publicIdFor(canonical: string | null | undefined, platform: string | null | undefined): string | null {
  if (!canonical || canonical === ERASED_CANONICAL || !platform) return null;
  return PUBLIC_ID.make(crypto, currentKeys(), canonical, platform);
}

/** { canonical, platform } behind a public id this install made; null for anything else. */
export function parsePublicId(id: unknown): { canonical: string; platform: string } | null {
  return PUBLIC_ID.parse(crypto, currentKeys(), id);
}

/** @test-only a fresh key from the current environment (the tests set the secret). */
export function _resetPublicIdKeyForTests(): void {
  keys = null;
}
