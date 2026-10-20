// The command's door into the site: `blackbranch doctor` asks for the site's
// facts from inside the web container, with the STREAM_API_SECRET web already holds — so the
// secret never leaves the container. Compared as digests, in constant time. Pure: tested directly.
import { createHash, timingSafeEqual } from "node:crypto";

export function doctorKeyOk(given: string | null, secret = process.env.STREAM_API_SECRET): boolean {
  if (!secret || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
