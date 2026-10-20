"use client";
// One chat on screen, never two: while the chat
// TUI has the terminal window, the chat list under it stands aside — a one-line
// stand-in instead of the rows — and comes back when the program or the window
// closes. One slot, like chatSender.ts: the shell raises it through its host, the
// lists read it through the hook. The chat box is untouched: it stays live.
import { useSyncExternalStore } from "react";

let taken = false;
const listeners = new Set<() => void>();

/** The TUI has the window (true) or gave it back (false). */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function setChatTakeover(on: boolean): void {
  if (taken === on) return;
  taken = on;
  for (const l of listeners) l();
}

/** @test-only exported for chatTakeover.test.ts (the slot without React); the hook reads it here. */
export const chatTakenOver = (): boolean => taken;

/** @test-only exported for chatTakeover.test.ts; the hook subscribes with it here. */
export function onChatTakeover(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Is the chat in the terminal right now? (Server: never.) */
export function useChatTakeover(): boolean {
  return useSyncExternalStore(onChatTakeover, chatTakenOver, () => false);
}

// The second slot: the TUI has a SLIDE-IN window, which slides all the way down and replaces
// the typing bar — the chat box under it folds away and the window takes the whole column. The
// terminal window raises it from the takeover above AND its presentation — a floating window
// leaves the chat box where it is.
let replaced = false;
const replacedListeners = new Set<() => void>();

/** The chat box is replaced by the TUI's window (true) or back (false). */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function setComposerReplaced(on: boolean): void {
  if (replaced === on) return;
  replaced = on;
  for (const l of replacedListeners) l();
}

/** @test-only exported for chatTakeover.test.ts (the slot without React); the hook reads it here. */
export const composerReplaced = (): boolean => replaced;

/** @test-only exported for chatTakeover.test.ts; the hook subscribes with it here. */
export function onComposerReplaced(fn: () => void): () => void {
  replacedListeners.add(fn);
  return () => { replacedListeners.delete(fn); };
}

/** Has the TUI's slide-in window replaced the chat box? (Server: never.) */
export function useComposerReplaced(): boolean {
  return useSyncExternalStore(onComposerReplaced, composerReplaced, () => false);
}
