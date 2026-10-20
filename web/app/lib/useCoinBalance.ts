"use client";

// Shared coin-wallet balance for every consumer (UserMenu chip, ChatInput cheer
// chip, StoreModal) — one module-level store + useSyncExternalStore, the same
// idiom as useClientState.ts. Deliberately NOT cached server-side and NOT pushed
// over the WS (the socket is a public broadcast — per-user balances would leak);
// instead it refreshes on mount/focus, and every spend/earn/checkout response
// hands the fresh number to setCoinBalance().

import { useCallback, useEffect, useSyncExternalStore } from "react";

let balance: number | null = null; // null = unknown / signed out
// The EARNED part of that balance — earned Qorm plus legacy winnings, never
// purchased. Held beside `balance` rather than in a store of its own: they
// come from one response and must never be shown from two different moments,
// or the parenthetical contradicts the number it is inside.
//
// null means UNKNOWN, and the UI must render no parenthetical for it. It
// goes null whenever `balance` moves through a path that cannot know the new
// split (a spend, an earn) — see setCoinBalance.
let earned: number | null = null;
let fetching = false;
// Bumped by every DIRECT write (a spend/earn/checkout response). A refresh
// snapshots it at launch and discards its own result if it moved: the refresh
// read the balance BEFORE that write, so its number is stale by construction —
// applying it would make the chip visibly jump back up after a purchase.
let writeEpoch = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Push a server-returned balance into the store (spend/earn/heartbeat responses).
 *
 *  INVALIDATES `earned`. None of these callers know the new split: a spend
 *  drains the purchased pool first and usually leaves earned untouched, but
 *  "usually" is not a number to render. Guessing a delta here would show a
 *  parenthetical that is quietly wrong; going null shows none at all, and
 *  useEarnedBalance refetches the moment anything is watching. */
export function setCoinBalance(next: number | null): void {
  writeEpoch += 1; // even a no-op set means a FRESHER read exists than any in-flight refresh
  if (balance === next) return;
  balance = next;
  earned = null;
  emit();
}

/** Re-fetch from the server (mount, window focus, after checkout completes). */
export function refreshCoinBalance(): void {
  if (fetching) return;
  fetching = true;
  const startedAt = writeEpoch;
  fetch("/api/points/balance")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { balance?: number; earned?: number } | null) => {
      if (!d || typeof d.balance !== "number") return;
      // A spend/earn response landed while this was in flight — that number is
      // fresher than what this request read. Drop ours; useEarnedBalance
      // refetches the split on its own the moment anything is watching.
      if (writeEpoch !== startedAt) return;
      // Written together, deliberately not through setCoinBalance — that
      // invalidates `earned`, which is exactly wrong here: this is the one
      // response that carries both, consistent with each other.
      balance = d.balance;
      earned = typeof d.earned === "number" ? d.earned : null;
      emit();
    })
    .catch(() => {})
    .finally(() => {
      fetching = false;
    });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/**
 * The signed-in user's coin balance (null while unknown). Pass `enabled=false`
 * for signed-out contexts so no 401-destined fetch fires.
 */
export function useCoinBalance(enabled: boolean): number | null {
  const value = useSyncExternalStore(subscribe, () => balance, () => null);
  const onFocus = useCallback(() => {
    if (enabled && document.visibilityState === "visible") refreshCoinBalance();
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    if (balance === null) refreshCoinBalance();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, onFocus]);
  return value;
}

/**
 * The EARNED part of the balance — the parenthetical's number (null while unknown).
 *
 * A second hook over the SAME store, not a second store — they arrive in one
 * response and showing them from two different moments would let the
 * parenthetical contradict the number it sits inside.
 *
 * Refetches whenever the value is unknown and something is watching, which is
 * what makes setCoinBalance's invalidation cheap: a spend blanks the
 * parenthetical for one round trip rather than showing a stale one.
 */
export function useEarnedBalance(enabled: boolean): number | null {
  const value = useSyncExternalStore(subscribe, () => earned, () => null);
  useEffect(() => {
    if (enabled && value === null) refreshCoinBalance();
  }, [enabled, value]);
  return value;
}
