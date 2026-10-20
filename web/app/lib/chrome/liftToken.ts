"use client";
// A chrome token that moves the window ceiling, written the way the keyboard's K is
// (useKeyboardLift.ts): from a layout effect, with KB_LIFT_EVENT dispatched on the element
// immediately BEFORE and AFTER the write, so a panel window's lift-follow (Window.tsx) reads its
// own box on both sides and eases the jump. The chat tab bar's
// fold flips `--pane-chrome-above` 0 ⇄ the bar's height; written as a React inline style it would
// be a second, unannounced jump of every top window's top edge while the keyboard is up.
//
// Announced only while the keyboard is up (`html.kb-open`): with K = 0 the ceiling is
// max(0, 0 − …) = 0 whatever this token says, so nothing laid out moves. The first write is
// silent for the same reason — nothing has been laid out against it yet.
import { useLayoutEffect, type RefObject } from "react";
import { KB_LIFT_EVENT, KB_OPEN_CLASS, keyboardInset, type KbLiftDetail } from "@/app/lib/useViewportHeightVar";

export function useLiftToken(ref: RefObject<HTMLElement | null>, name: string, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const was = el.style.getPropertyValue(name);
    if (was === value) return;
    const doc = el.ownerDocument;
    const announce = was !== "" && doc.documentElement.classList.contains(KB_OPEN_CLASS);
    const Ev = doc.defaultView?.CustomEvent ?? CustomEvent;
    const fire = (phase: KbLiftDetail["phase"]) =>
      el.dispatchEvent(new Ev<KbLiftDetail>(KB_LIFT_EVENT, { bubbles: true, detail: { phase, k: keyboardInset() } }));
    if (announce) fire("before");
    el.style.setProperty(name, value);
    if (announce) fire("after");
  }, [ref, name, value]);
}
