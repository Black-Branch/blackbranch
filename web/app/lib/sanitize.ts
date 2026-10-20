// Strips invisible/dangerous unicode: C0 controls (excl. \t, \n, \r),
// DEL, C1 controls, zero-width chars, bidirectional overrides,
// line/paragraph separators, word joiners, BOM.
const INVISIBLE_RE =
  /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u2069\uFEFF]/g;

export function sanitizeDisplayName(raw: string): string {
  return raw
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

/**
 * `max` defaults to 500 — the general chat-message ceiling every existing
 * caller relies on (the donate route, support tickets/messages/reports).
 * `chat/send/route.ts` passes its own role-aware `charLimit + 1` so the
 * route's own over-limit check (comparing against `charLimit`, not this
 * function's cap) is the thing that actually rejects — this only ever
 * truncates, one past the limit is intentional so lengths above the real
 * ceiling still land on a length the check reads as "over," never clamped
 * down to look exactly at it.
 */
export function sanitizeChatMessage(raw: string, max = 500): string {
  return raw
    .replace(INVISIBLE_RE, "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}
