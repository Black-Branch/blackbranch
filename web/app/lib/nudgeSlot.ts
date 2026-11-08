"use client";

// One first-run prompt at a time. The prompts that greet a new viewer (secure
// your account, install the app, the help desk's hello) share a single slot:
// among those wanting it in the same tick the earlier in ORDER holds it; a
// holder keeps it until it stops wanting (its dismissal, or it unmounts); after
// that the slot stays empty for the rest of the page load, so dismissing one
// prompt never makes the next one appear in its place.

import { useEffect, useSyncExternalStore } from "react";

export type NudgeId = "secure-account" | "pwa-install" | "help-desk";

const ORDER: readonly NudgeId[] = ["secure-account", "pwa-install", "help-desk"];

const wanting = new Set<NudgeId>();
const listeners = new Set<() => void>();
let holder: NudgeId | null = null;
let spent = false;
let settling = false;

function emit() {
  for (const l of listeners) l();
}

// Deferred to a microtask so every wanter of one commit is counted before the
// order decides.
function settle() {
  settling = false;
  if (spent || holder) return;
  const next = ORDER.find((id) => wanting.has(id));
  if (!next) return;
  holder = next;
  emit();
}

function want(id: NudgeId) {
  wanting.add(id);
  if (spent || holder || settling) return;
  settling = true;
  queueMicrotask(settle);
}

function release(id: NudgeId) {
  wanting.delete(id);
  if (holder !== id) return;
  holder = null;
  spent = true;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** True while this prompt holds the one first-run slot. */
export function useNudgeSlot(id: NudgeId, wants: boolean): boolean {
  useEffect(() => {
    if (!wants) return;
    want(id);
    return () => release(id);
  }, [id, wants]);
  const current = useSyncExternalStore(subscribe, () => holder, () => null);
  return wants && current === id;
}

/**
 * @test-only The slot lives for a page load (module state); node --test runs a
 * file's tests in one process, so each test starts a fresh "load" with this.
 */
export function _resetNudgeSlotForTests(): void {
  wanting.clear();
  holder = null;
  spent = false;
  settling = false;
  emit();
}
