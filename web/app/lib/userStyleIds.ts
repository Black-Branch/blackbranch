// The `?ids=` of GET /api/users/colors and /api/users/looks. Those two feed name rendering and are
// public, so they answer only for the Matrix ids a client is about to draw — never "everyone who
// has a colour", which listed every account on the site. Commas cannot occur in a Matrix id, so
// the list is comma-separated; anything not shaped like one is dropped.
import { createSlidingWindowLimiter } from "./rateLimit.ts";

/** Most ids one request may ask for (the client asks in chunks below this). */
const MAX_STYLE_IDS = 200;

const MXID = /^@[^\s:,]{1,255}:[A-Za-z0-9.\-[\]:]{1,255}$/;

export function parseStyleIds(raw: string | null): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (MXID.test(id)) out.add(id);
    if (out.size >= MAX_STYLE_IDS) break;
  }
  return [...out];
}

/** Per address: a chat screen asks once per batch of new names, so a minute's allowance is wide. */
const STYLE_REQUESTS_PER_MIN = 120;
const limiter = createSlidingWindowLimiter(60_000, STYLE_REQUESTS_PER_MIN);
/** Check-and-count one request from `addressKey` (rateLimit.ipKey). True = refuse. */
export function styleLookupLimited(addressKey: string): boolean {
  return limiter(addressKey);
}
