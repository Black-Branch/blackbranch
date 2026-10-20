// The chat character limits, in one place, so the box, the counter and the
// send route can never disagree. The limit is shown within the typing area
// when approaching.
//
// Viewers: 200 — YouTube's own live-chat limit, so a cross-posted message
// never fails silently there. Mods and admins: 500 — announcements come from
// that side. A coin-paid TTS message: 200 for everyone, because that is what
// stream-api/alert.js speaks of it (its tts_msg branch slices at 200) — the
// box must never promise more than the voice reads.
//
// The three numbers stay module-private consts: nothing outside chatCharLimit
// reads them directly, and an export with no non-test consumer fails
// check-orphans. Only the function and
// COUNTER_SHOW_WITHIN (read by CharCounter.tsx) cross this file's edge.
const VIEWER_CHAT_CHARS = 200;
const STAFF_CHAT_CHARS = 500;
const TTS_MESSAGE_CHARS = 200;

/** The counter appears when this many characters or fewer remain. */
export const COUNTER_SHOW_WITHIN = 50;

export function chatCharLimit(
  role: { isMod: boolean; isAdmin: boolean },
  spendMode: "tts" | "highlight" | null = null
): number {
  if (spendMode === "tts") return TTS_MESSAGE_CHARS;
  return role.isMod || role.isAdmin ? STAFF_CHAT_CHARS : VIEWER_CHAT_CHARS;
}
