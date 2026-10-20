"use client";
import { useSyncExternalStore } from "react";
import { currentBinding, subscribeComposerBinding, type ComposerBinding } from "./composerBinding";

/** The composer's current holder, reactive — drives the send-to control's face.
 *  The submit path does NOT read this; it reads currentBinding() synchronously
 *  (a bind between render and submit must win). */
export function useComposerBinding(): ComposerBinding | null {
  return useSyncExternalStore(subscribeComposerBinding, currentBinding, () => null);
}
