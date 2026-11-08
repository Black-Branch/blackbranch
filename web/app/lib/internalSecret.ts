// The internal secret (STREAM_API_SECRET), checked on web's own internal routes: the host's doctor
// and the community reconciler call web with it. Compared as digests, in constant time, so neither
// its length nor a prefix of it leaks. No secret configured = every door shut.
import { createHash, timingSafeEqual } from "node:crypto";

export function secretOk(given: string | null, secret = process.env.STREAM_API_SECRET): boolean {
  if (!secret || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <secret>`, the header stream-api's requireInternal takes. */
export function internalBearerOk(authorization: string | null, secret = process.env.STREAM_API_SECRET): boolean {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  return secretOk(m?.[1] ?? null, secret);
}
