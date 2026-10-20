// PgUp / PgDn / Home / End scroll the CHAT while the composer has focus.
// The browser scrolls the focused scrollable element, and while typing that
// is the textarea, so without this these keys do nothing to the feed. PgUp/PgDn always mean the feed — a single-line textarea has no pages.
// Home/End only when the box is EMPTY: with text in it they are caret keys,
// and stealing them would break editing. Any modifier hands the key back to
// the browser: Ctrl+PgUp/PgDn switches tabs, Shift+PgUp/PgDn selects.

import { REANCHOR_PX } from "./useAnchoredChat.ts";

export type ChatScrollKey = "PageUp" | "PageDown" | "Home" | "End";

export function chatScrollKey(
  key: string, { textEmpty, modified }: { textEmpty: boolean; modified: boolean }
): ChatScrollKey | null {
  if (modified) return null;
  if (key === "PageUp" || key === "PageDown") return key;
  if ((key === "Home" || key === "End") && textEmpty) return key;
  return null;
}

/** A page is most of the visible feed, so the last lines of one page are the
 *  first of the next — the reader keeps their place. */
const PAGE_FRACTION = 0.85;

// The keys go THROUGH the anchor engine, never around it. A scrollTop write
// fires a scroll event with no gesture window open; useAnchoredChat reads that
// as layout noise and, while anchored, corrects it straight back to the bottom,
// so a raw PgUp on a live feed moves nothing. An upward key
// pauses first (the engine then leaves the position alone); a downward key
// that lands within the engine's re-anchor slack goes back to live through the
// anchor, because that is what the eye calls the bottom (the same slack a
// touch landing gets).
export function scrollChatByKey(
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
  key: ChatScrollKey,
  anchorToBottom: () => void,
  pause: () => void
): void {
  const page = Math.max(1, Math.round(el.clientHeight * PAGE_FRACTION));
  // Pause only when there is somewhere to go: at the top already (or a feed
  // shorter than its box) the key is a no-op, not a freeze of the live feed.
  if (key === "PageUp") { if (el.scrollTop > 0) pause(); el.scrollTop = Math.max(0, el.scrollTop - page); }
  else if (key === "Home") { if (el.scrollTop > 0) pause(); el.scrollTop = 0; }
  else if (key === "PageDown") {
    const target = Math.min(el.scrollHeight, el.scrollTop + page);
    if (el.scrollHeight - target - el.clientHeight <= REANCHOR_PX) anchorToBottom();
    else el.scrollTop = target;
  }
  // End = back to live, through the anchor so the feed re-attaches to new
  // messages rather than sitting one pixel short of the bottom.
  else anchorToBottom();
}
