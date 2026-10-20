import { useRef, useCallback } from "react";
import { Q_POINTER_COARSE } from "./deviceQueries.ts";

export type LongPressPosition = { x: number; y: number };

export function useLongPress(
  onLongPress: (pos: LongPressPosition) => void,
  delay = 350,
  // Cancel once the touch drifts more than this many px. 0 = any movement
  // cancels — for presses whose action is disruptive enough (e.g. PresetSlots'
  // blocking rename prompt) that firing mid-scroll is worse than a missed press.
  moveTolerance = 10
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  // CHROME DROPS INPUT FOCUS WHEN ITS OWN LONG PRESS BEGINS. There is nothing
  // to preventDefault — MEASURED on a phone with ?pressdebug=1:
  //
  //   2810ms touchstart  on span      active=textarea.chat-input-field  vv.h=581
  //   3298ms blur        on textarea  active=body                       vv.h=581
  //   3299ms focusout    on textarea  → -                               vv.h=581
  //   3302ms contextmenu on span                                        vv.h=581
  //   3306ms   contextmenu prevented=true
  //   3328ms vv.resize   h=891     ← the keyboard closes AFTER the blur
  //
  // Read it carefully, because it rules out the obvious fixes:
  //   • the blur is 4ms BEFORE `contextmenu`, so suppressing that event cannot
  //     help — our preventDefault does run (prevented=true) and is simply late;
  //   • `focusout` carries relatedTarget `-` (NULL). Nothing took focus, so there
  //     is no competing element and no mousedown to cancel — which is why any
  //     keepFocus-shaped fix misses;
  //   • the blur is Chrome's own long-press threshold, not anything we
  //     dispatch — and it is NOT a fixed number. Measured on the same device:
  //     488ms in one trace, 203ms and 207ms in two others. Our timer fires at
  //     350ms, so arming the guard from the timer works in the 488ms case and
  //     silently does nothing in the 200ms ones (it seems to depend on whether
  //     the keyboard was opened by hand). ARM AT TOUCHSTART: there is no
  //     threshold to race if we are already listening.
  //
  // The keyboard follows focus, so the only cure is to put focus back inside the
  // ~30ms before the IME tears down. Restoring it synchronously in `focusout`
  // means the keyboard never animates away, rather than closing and reopening.
  // Disarms the focus guard, if one is armed. Held in a ref because `start` arms
  // it and `end`/`abort` take it down.
  const disarmRef = useRef<(() => void) | null>(null);

  const armFocusGuard = useCallback(() => {
    if (typeof document === "undefined") return;
    // Only while a keyboard is actually UP. Dismissing it by hand does not
    // blur the composer — measured: after `vv.resize h=891` the next tap still
    // reports `active=textarea.chat-input-field`. So "activeElement is a text
    // field" does NOT mean "there is a keyboard", and restoring focus with it
    // down would summon one the user had just put away.
    // Read off <html> rather than importing the keyboard hook: this is a
    // generic gesture hook and must not depend on the app shell (and the
    // import would break its node render test, which loads this file directly).
    // publishKb() is still the ONE writer of that class.
    if (!document.documentElement.classList.contains("kb-open")) return;
    const el = document.activeElement as HTMLElement | null;
    // Only a text field — those are the ones holding a keyboard open.
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    // NEVER TWO GUARDS AT ONCE. An arm that installs its own listener and
    // overwrites disarmRef orphans the previous one — which then survives to
    // its 5s backstop and keeps grabbing focus back long after its gesture is
    // over: the composer stops expanding, send-to loses its default, and its
    // first press does nothing. Those are the fingerprints of a stale guard
    // fighting the composer.
    disarmRef.current?.();
    let done = false;
    const restore = (e: FocusEvent) => {
      if (done || e.target !== el) return;
      // ONLY Chrome's spontaneous drop, which carries relatedTarget NULL
      // (measured: `focusout on textarea → -`). A blur caused by the user moving
      // focus somewhere real names that element, and stealing focus back from it
      // would eat the first tap on `send to:`.
      if (e.relatedTarget !== null) return;
      done = true;
      // preventScroll: refocusing must not yank the chat list back.
      el.focus({ preventScroll: true });
      // Some engines ignore a focus() issued during focusout dispatch; retry once
      // on the next task, and only if it actually failed to take.
      setTimeout(() => { if (document.activeElement !== el) el.focus({ preventScroll: true }); }, 0);
    };
    document.addEventListener("focusout", restore, { capture: true });
    const disarm = () => {
      done = true;
      document.removeEventListener("focusout", restore, { capture: true });
      disarmRef.current = null;
    };
    disarmRef.current = disarm;
    // Backstop only, and SHORT. The gesture normally disarms on release; this
    // covers a touchend that never arrives (tab hidden, sequence lost). It was
    // 5s, which is an eternity for something that can pull focus.
    setTimeout(disarm, 1200);
  }, []);

  /**
   * Take the guard down a beat after the gesture ends — a beat, because the blur
   * can land just after release. One-shot either way: a deliberate tap on
   * something else must be able to take focus away for good.
   */
  const disarmFocusGuard = useCallback(() => {
    const disarm = disarmRef.current;
    if (!disarm) return;
    // Detach from the ref immediately so a press starting inside the tail cannot
    // find this one still registered, and so nothing else can re-disarm it.
    disarmRef.current = null;
    // A short tail only: the blur can land just after release, but every extra
    // millisecond is time this can take focus off something the user chose.
    setTimeout(disarm, 150);
  }, []);

  const start = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startPos.current = { x: touch.clientX, y: touch.clientY };
      firedRef.current = false;
      // AT TOUCHSTART, not when the timer fires. Chrome's blur has been
      // measured at 203ms, 207ms and 488ms on the SAME device — arming from our
      // 350ms timer wins the 488ms race and loses both 200ms ones. Arming here
      // costs one bounded document listener for the length of a press and races
      // nothing. It is inert unless a blur actually arrives while the keyboard
      // is up, so an ordinary tap arms and disarms without ever acting.
      armFocusGuard();
      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        onLongPress({ x: touch.clientX, y: touch.clientY });
      }, delay);
    },
    [onLongPress, delay, armFocusGuard]
  );

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPos.current = null;
  }, []);

  // A long press that FIRED must swallow its own release. Otherwise the
  // browser follows touchend with compatibility mouse events (mousedown, mouseup,
  // click) at the release point, and those land on the element UNDER the finger —
  // which is not the menu, because the menu renders 8px below the press point. So
  // the mousedown reads as a press outside the menu and useOutsideClick closes it
  // instantly: measured on a real long press, the menu opens and is gone by the
  // time the finger lifts — visible only while holding.
  //
  // Cancelling touchend suppresses the whole compatibility sequence, which also
  // covers the mirror-image hazard: near the bottom of the viewport the menu
  // flips ABOVE the press point, putting an item under the finger, and the same
  // synthetic click would activate it on release.
  //
  // Only when it fired — a normal tap still needs its click.
  //
  // The event is optional because PresetSlots also calls this bare, to reset the
  // single shared timer before starting a new press.
  const end = useCallback((e?: React.TouchEvent) => {
    if (firedRef.current) {
      e?.preventDefault();
      firedRef.current = false;
    }
    disarmFocusGuard();
    cancel();
  }, [cancel, disarmFocusGuard]);

  // The browser CANCELS a touch sequence the moment the OS or the UA claims
  // it — an edge "back" swipe, a system gesture, a scroll handoff — and from
  // that point it sends NO further touchmove or touchend for that sequence.
  // Without this handler the armed timer would have nothing left that could
  // stop it, and would fire the menu into a gesture aimed at the operating
  // system.
  //
  // The movement guard cannot cover this: an edge swipe begins with the finger
  // effectively still (the OS is still deciding whether it owns the gesture), so
  // any touchmove that does arrive first is inside the tolerance — and once the
  // takeover happens there are no more events at all. The menu carries mod
  // delete, so this matters.
  //
  // Clears `firedRef` as well as the timer. A cancel after the press already
  // fired would otherwise leave the flag set, and the NEXT ordinary tap would
  // have its touchend preventDefault'd — silently losing that tap's click.
  // (`useAnchoredChat` already listens for touchcancel for the same reason.)
  const abort = useCallback(() => {
    firedRef.current = false;
    disarmFocusGuard();
    cancel();
  }, [cancel, disarmFocusGuard]);

  const move = useCallback((e: React.TouchEvent) => {
    if (!startPos.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - startPos.current.x;
    const dy = touch.clientY - startPos.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > moveTolerance) cancel();
  }, [cancel, moveTolerance]);

  // CHROME FIRES `contextmenu` ON LONG PRESS, AND THAT DROPS THE KEYBOARD.
  // Chrome-Android raises a contextmenu event when a press passes its own
  // long-press threshold; running its default action tears down the
  // composer's focus and the soft keyboard with it. Firefox Android does not,
  // so the bug shows in Chrome only.
  //
  // `.touch-no-select` (user-select:none + -webkit-touch-callout:none) does NOT
  // cover this — those suppress selection and the iOS callout, not the event.
  // Only preventDefault does.
  //
  // COARSE ONLY. On a fine pointer this same event is the right-click menu, and
  // a chat row has no menu of its own to replace it — killing it would take
  // "copy"/"inspect" away from every desktop user to fix a phone bug.
  // (SpacesRail suppresses this too; the fix rides with the gesture instead of
  // being remembered per call site.)
  const contextMenu = useCallback((e: React.MouseEvent) => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia(Q_POINTER_COARSE).matches) return;
    e.preventDefault();
  }, []);

  return {
    onTouchStart: start,
    onTouchEnd: end,
    onTouchMove: move,
    onTouchCancel: abort,
    onContextMenu: contextMenu,
  };
}
