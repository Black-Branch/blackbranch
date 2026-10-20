// GET /api/chat/history is public and pages back through every message ever sent, 100 rows at a
// time — without a limit, a script can walk the whole archive in minutes. Per address, a sliding
// minute: generous for a viewer scrolling back (a page per second), tighter for a signed-out caller.
import { createSlidingWindowLimiter } from "./rateLimit.ts";

const HISTORY_PER_MIN_SIGNED_IN = 60;
const HISTORY_PER_MIN_SIGNED_OUT = 20;

const limiter = createSlidingWindowLimiter(60_000, HISTORY_PER_MIN_SIGNED_OUT);

/** Check-and-count one history request from `addressKey` (rateLimit.ipKey). True = refuse. */
export function chatHistoryLimited(addressKey: string, signedIn: boolean): boolean {
  return limiter(addressKey, signedIn ? HISTORY_PER_MIN_SIGNED_IN : HISTORY_PER_MIN_SIGNED_OUT);
}
