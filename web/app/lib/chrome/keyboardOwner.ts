// Who owns the phone's keyboard, as the window geometry needs to know it. Read from
// the DOM at the moment it is asked — `html.kb-open` (the one keyboard truth, useViewportHeightVar)
// and where focus is — never stored, so it can never disagree with what is on screen.
import { KB_OPEN_CLASS } from "@/app/lib/useViewportHeightVar";

const kbOpen = (doc: Document) => doc.documentElement.classList.contains(KB_OPEN_CLASS);

/** A top TASK window you are typing in, with the keyboard up: it takes the whole visible pane
 *  (chrome.css says the same with `html.kb-open … :focus-within`), and its pull reaches it. */
export function ownsKeyboard(panel: HTMLElement | null): boolean {
  return !!panel && panel.dataset.from === "top" && panel.dataset.kind === "task"
    // `contains(activeElement)` is `:focus-within` said in JS — jsdom caches the selector's
    // answer across a focus move, the DOM question it cannot get wrong.
    && kbOpen(panel.ownerDocument) && panel.contains(panel.ownerDocument.activeElement);
}

/** The keyboard is up and a top window is open in this column: a downward drag there is the
 *  window's, never the tab bar's reveal. */
export function topWindowUnderKeyboard(column: Element): boolean {
  return kbOpen(column.ownerDocument) && !!column.querySelector('.chrome-window-panel[data-from="top"]');
}
