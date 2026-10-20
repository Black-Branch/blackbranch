"use client";

import { useSyncExternalStore } from "react";
import { Q_TOUCH_PRIMARY } from "./deviceQueries.ts";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(Q_TOUCH_PRIMARY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * True when touch is the PRIMARY input — a phone or a tablet, never a
 * touchscreen laptop (deviceQueries.ts, Q_TOUCH_PRIMARY: the keyboard code's
 * own question). For the affordances that exist because there is no hardware
 * keyboard: the terminal's key row (Tab, Ctrl, the symbols a phone keyboard
 * hides).
 *
 * Not a layout check. A narrow window on a computer is NOT touch primary,
 * and a phone in landscape IS — a key row that follows width shows up in a
 * clearly non-mobile layout. useNarrowViewport answers "is there room for two
 * columns?"; this answers "is there a finger and no keyboard?".
 *
 * Server snapshot `false`: the SSR'd HTML is the computer's, and the client
 * syncs to the real answer in the same commit (useNarrowViewport's reasoning).
 */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function useTouchPrimary(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(Q_TOUCH_PRIMARY).matches,
    () => false,
  );
}
