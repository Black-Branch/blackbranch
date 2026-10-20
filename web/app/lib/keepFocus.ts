// Keep the soft keyboard up while the user works the chat.
//
// THE PROBLEM: a <button> takes focus on press, which blurs the textarea, which
// closes the phone keyboard — and then the composer drops back down and you
// have to tap the field again to carry on typing. Every control that sits
// BESIDE the text field has this: send-to, the tools trigger, the emote
// button, Matrix's attach button.
//
// THE FIX: cancel the default action of the press. `mousedown` is what moves
// focus, and preventing it leaves focus (and the keyboard) exactly where it was
// while the subsequent `click` still fires normally. Touch browsers synthesise
// mousedown before click, so this covers phones as well as desktop.
//
// It covers the whole chat surface, not only the composer: voting, replying,
// tapping a name, opening a poll option, boosting a sticker, picking a row off
// the long-press menu — and the SEND BUTTON itself — would otherwise each close
// the keyboard, so a phone user would lose it between every two messages while
// Enter kept it. The rule is "chat interactions do not cost you the
// keyboard", and the exceptions are the two named below.
//
// TWO CARVE-OUTS — do NOT use this on:
//   1. A control that hands focus to an input of its own (the emote picker's
//      search box) — it needs the browser's normal focus handling, or keyboard
//      users lose their way in.
//   2. A control that REPLACES the view rather than floating over it (SpendChip's
//      "Top up" opens the store). Keeping the keyboard up there just parks it on
//      top of the panel the user asked for. Small anchored things that appear
//      NEXT to the press — the user card, a context menu, the boost popover —
//      are the opposite case and DO keep it.

import type { MouseEvent } from "react";
import { isKeyboardOpen } from "./useViewportHeightVar";
import { Q_POINTER_COARSE } from "./deviceQueries";

/** `onMouseDown={keepFocus}` — the press does not steal focus from the field. */
export function keepFocus(e: MouseEvent): void {
  // Same gate as keepFocusCoarse, and for the same reason: with the keyboard
  // already down, holding focus on the composer only lets the next tap
  // re-summon it. On a FINE pointer this stays unconditional — there is no
  // keyboard to reason about, and preventing the press from stealing focus is
  // what keeps the caret in the field where the user left it.
  if (typeof window !== "undefined"
      && window.matchMedia(Q_POINTER_COARSE).matches
      && !isKeyboardOpen()) return;
  e.preventDefault();
}

/**
 * `onMouseDown={keepFocusCoarse}` — same thing, but only on a touch pointer.
 *
 * For NON-focusable surfaces, i.e. the message row itself. A tap anywhere on a
 * message body blurs the composer just as surely as a button does, but a bare
 * preventDefault on the row would also kill desktop drag-selection, which is a
 * KEPT feature (globals.css scopes `.touch-no-select` to `pointer: coarse` for
 * exactly that reason). On a coarse pointer selection is already off, so there
 * is nothing left to lose; on a fine pointer there is no keyboard to save.
 */
export function keepFocusCoarse(e: MouseEvent): void {
  if (typeof window === "undefined") return;
  if (!window.matchMedia(Q_POINTER_COARSE).matches) return;
  // ONLY WHILE THERE IS A KEYBOARD TO KEEP: after the user closes the keyboard
  // by hand, tapping another message must not open it again.
  //
  // Dismissing the keyboard by hand does NOT blur the composer (measured with
  // ?pressdebug=1: after `vv.resize h=891` the very next tap still reports
  // `active=textarea.chat-input-field`). Chrome hides the IME and leaves DOM
  // focus alone. So holding focus here would keep an invisible keyboard
  // "focused", and the next user gesture would re-summon it.
  //
  // The rule this file exists for is "chat interactions must not COST you the
  // keyboard" — which says nothing about a keyboard the user has already put
  // away. With it down there is nothing to protect, so the tap behaves
  // normally and focus is allowed to leave.
  if (!isKeyboardOpen()) return;
  e.preventDefault();
}
