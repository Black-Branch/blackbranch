"use client";

import { useEffect, useRef } from "react";

// Lightweight global keyboard-shortcut layer. Bindings are matched against
// keydown with exact modifier equality (so Alt+R never fires on Shift+Alt+R).
// Shortcuts are ignored while the user is typing in an input/textarea/contentEditable.
//
// The bindings array can be rebuilt each render (e.g. to close over fresh state)
// without re-subscribing — the listener always reads the latest via a ref.

export type KeyCombo = {
  key: string;          // e.g. "r" (case-insensitive)
  alt?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
};

export type KeyBinding = {
  combo: KeyCombo;
  handler: (e: KeyboardEvent) => void;
};

function isEditableTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = n.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || n.isContentEditable;
}

export function useKeyboardShortcuts(bindings: KeyBinding[], enabled = true) {
  const ref = useRef(bindings);
  // Keep the latest bindings without re-subscribing the listener.
  useEffect(() => { ref.current = bindings; });

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(document.activeElement)) return;
      for (const b of ref.current) {
        const c = b.combo;
        if (e.key.toLowerCase() !== c.key.toLowerCase()) continue;
        if (!!c.alt !== e.altKey) continue;
        if (!!c.shift !== e.shiftKey) continue;
        if (!!c.ctrl !== e.ctrlKey) continue;
        if (!!c.meta !== e.metaKey) continue;
        e.preventDefault();
        b.handler(e);
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
