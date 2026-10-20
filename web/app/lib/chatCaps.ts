// The chat buffer's row caps — one plain module, because two sides read them:
// useChatMessages ("use client") applies them, and the SERVER pages read
// CHAT_LIVE_CAP to know how many rows to render before hydration
// (app/chat/page.tsx, app/(main)/page.tsx, app/popout/page.tsx). A server
// component cannot import a value from a "use client" module — it gets a
// client reference, not the number — so the caps live here.

/** Rows kept while anchored to the bottom (the live view). */
export const CHAT_LIVE_CAP = 80;
/** Hard ceiling while the user is scrolled back in history — bounds DOM/memory
 *  without trimming the rows they're reading. */
export const CHAT_SCROLLBACK_CAP = 1000;
/** Behavior › Chat history length, per device: the SAME two caps, three sizes.
 *  It replaces the "Reduced chat history" switch; settingsMigrate.migrateHistLength
 *  turns a saved ON into Short. */
export type HistoryLength = "short" | "default" | "long";
const HISTORY_CAPS: Record<HistoryLength, { live: number; scrollback: number }> = {
  short:   { live: 50, scrollback: 300 },
  default: { live: CHAT_LIVE_CAP, scrollback: CHAT_SCROLLBACK_CAP },
  long:    { live: 150, scrollback: 2000 },
};
/** The caps for the stored length (`chatStyle_histLength`); unset or junk = Default. */
export function historyCaps(lengthLs: string | null): { live: number; scrollback: number } {
  return lengthLs != null && Object.hasOwn(HISTORY_CAPS, lengthLs) ? HISTORY_CAPS[lengthLs as HistoryLength] : HISTORY_CAPS.default;
}
/** Rows per scroll-back page. */
export const CHAT_HISTORY_PAGE = 50;
/** The OBS source's cap (/overlay/chat) — it never scrolls up, so it keeps less. */
export const CHAT_OVERLAY_CAP = 60;
