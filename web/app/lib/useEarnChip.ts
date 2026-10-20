"use client";

// The "+2q" chip's store: one module-level value + useSyncExternalStore, the
// same idiom as useCoinBalance.ts and useStorePrices.ts.
//
// IT COALESCES. A heartbeat window can carry several awards — a first
// message, the message point that came with it, an upvote somebody left while
// you were reading. Shown one after another, 1.5s each, the chips read as
// stuttering and run out of bounds. Since the chip does not say WHAT earned
// the Qorm, five chips in a row carry exactly the information of one — the
// total — split into five restarts of the same animation. And five
// short-lived wide chips are five chances to overflow the composer.
//
// So the window sums. "+9q" once, not "+5q +1q +2q +1q". There is no queue
// ordering them: a mechanism nothing needs is a cost with no reader.
//
// NOT wired into ChatMessage. That component renders once per message and is
// memoized; subscribing it to a store that ticks every 1.5s would re-render the
// whole backlog on every award. The chip belongs to the composer surface, which
// renders once.

import { useSyncExternalStore } from "react";
import type { EarnChipItem } from "./coins";

/** How long one chip is on screen. Exported so EarnChip.tsx can drive its CSS
 *  animation from the same number instead of restating 1.5s and drifting. */
export const EARN_CHIP_MS = 1500;

type Showing = {
  /** Qorm to announce, or 0 for nothing on screen. */
  points: number;
  /** Increments per chip shown. The element is keyed on this, so two awards of
   *  the SAME amount in a row still replay the animation — without it React
   *  reuses the element and the second "+1q" appears as a chip that never
   *  moved. */
  seq: number;
};

let showing: Showing = { points: 0, seq: 0 };
/** Earned while a chip was already on screen. Shown as one follow-up rather
 *  than added to the visible number — a chip whose value changes mid-animation
 *  reads as a glitch, not as more Qorm. */
let pending = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function advance() {
  if (pending === 0) {
    timer = null;
    showing = { points: 0, seq: showing.seq };
    emit();
    return;
  }
  showing = { points: pending, seq: showing.seq + 1 };
  pending = 0;
  emit();
  timer = setTimeout(advance, EARN_CHIP_MS);
}

/** Announce a heartbeat's worth of awards. Safe to call with an empty list —
 *  most beats award nothing, and the common path must not touch the store or
 *  every idle viewer re-renders once a minute for no reason. */
export function pushEarnChips(items: readonly EarnChipItem[]): void {
  const total = items.reduce((n, i) => n + (i.points > 0 ? i.points : 0), 0);
  if (total === 0) return;
  pending += total;
  // Already animating: the running timer picks this up when its slot ends.
  if (timer === null) advance();
}

/** @test-only what `useEarnChip` would return right now, without React. The
 *  store's whole behaviour is its TIMING — coalescing, hand-off, the seq bump —
 *  and none of that is observable through the hook without a renderer. */
export function peekEarnChip(): Showing {
  return showing;
}

/** @test-only the store outlives any single test, so a suite that pushes chips
 *  would leak a pending timer and a half-drained total into the next one. Not
 *  called in production — the store is deliberately process-wide. */
export function resetEarnChips(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = 0;
  showing = { points: 0, seq: 0 };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = () => showing;
// The server renders nothing: there is no award to announce on a first paint,
// and a server snapshot differing from the client's would be a hydration
// mismatch on every page load.
const EMPTY: Showing = { points: 0, seq: 0 };
const getServerSnapshot = () => EMPTY;

/** The Qorm currently being announced (0 for nothing). */
export function useEarnChip(): Showing {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
