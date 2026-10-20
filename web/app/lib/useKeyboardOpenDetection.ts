"use client";

import { useSyncExternalStore } from "react";
import { subscribeKeyboardOpen, isKeyboardOpen, keyboardInset } from "./useViewportHeightVar";

// Is the on-screen keyboard up? A thin reader of the ONE truth published by
// useViewportHeightVar — the state machine that actually moves the app shell.
//
// Not a second, independent detector with its own baseline, thresholds and
// focus listeners: two state machines answering one question would fold the
// video bars on a DIFFERENT frame than the shell moves (visible flicker), and
// the pair could genuinely disagree about `interactive-widget=resizes-content`,
// prediction, the pinch-zoom stand-down and the PWA env() tier. One mechanism
// owns the keyboard; this hook just subscribes.
//
// Server snapshot is `false`: no keyboard exists at SSR time, and the bars
// must render in their open state for first paint.
export function useKeyboardOpenDetection(): boolean {
  return useSyncExternalStore(subscribeKeyboardOpen, isKeyboardOpen, () => false);
}

// How far the keyboard eats into the viewport, in CSS px — the SAME truth, the
// same subscription, the same frame. This is the one scalar the mobile layer
// architecture positions on: every layer's offset is a function of it, so a
// second reading of "where is the keyboard" can never disagree with the first.
//
// It is the COMMITTED inset, so it is discrete by construction — it changes
// once per keyboard open and holds. Nothing that reads it is exposed to the
// platform's mid-animation jitter.
//
// Server snapshot is 0: no keyboard exists at SSR time, and every layer must
// render at rest for first paint.
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribeKeyboardOpen, keyboardInset, () => 0);
}
