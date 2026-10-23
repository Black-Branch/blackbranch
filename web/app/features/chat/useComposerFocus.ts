"use client";

import { useCallback, useState, type RefObject } from "react";

/**
 * Does the chat box have focus? The composer grows only while it does and holds text.
 *
 * onFocus alone is not enough: a box tapped before the page hydrated (a phone on a slow load)
 * got its focus before React was listening, so no onFocus ever arrives and the box would stay
 * one line tall while you type. A keystroke in the box is proof it has focus, so `noteInput`
 * (called on every change) catches it up. It checks the document's active element, so a draft
 * restored into an unfocused box does not claim focus.
 */
export function useComposerFocus(inputRef: RefObject<HTMLTextAreaElement | null>) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const noteInput = useCallback(() => {
    const el = inputRef.current;
    if (el && el.ownerDocument.activeElement === el) setFocused(true);
  }, [inputRef]);
  return { focused, onFocus, onBlur, noteInput };
}
