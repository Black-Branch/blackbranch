// Whether the phone's keyboard is up under a top window, as the chat column needs to know it. Read
// from the DOM at the moment it is asked — `html.kb-open` (the one keyboard truth,
// useViewportHeightVar) — never stored, so it can never disagree with what is on screen.
import { KB_OPEN_CLASS } from "@/app/lib/useViewportHeightVar";

const kbOpen = (doc: Document) => doc.documentElement.classList.contains(KB_OPEN_CLASS);

/** The keyboard is up and a top window is open in this column: a downward drag there is the
 *  window's, never the tab bar's reveal. */
export function topWindowUnderKeyboard(column: Element): boolean {
  return kbOpen(column.ownerDocument) && !!column.querySelector('.chrome-window-panel[data-from="top"]');
}
