"use client";

// Live store prices, from GET /api/store/prices.
//
// One module-level store + useSyncExternalStore, the same idiom as
// useCoinBalance.ts — every consumer (the composer's sticker row, the store
// modal, each spend hook) reads the same numbers from one fetch. Unlike the
// wallet these are not per-user: the price table is site-wide, so sharing it is
// strictly right rather than merely cheap.
//
// NOT POLLED, deliberately. Prices move BETWEEN streams, not within one, so
// a poll would spend a request a minute to observe a number that changes once a
// day. Fetched once and refreshed on focus, which is the moment a viewer could
// have been away long enough for a recompute to have happened.
//
// There is no fallback constant, and there must never be one. While `prices`
// is null the caller shows "—" and disables the buy control. A stale constant
// is exactly the "charged a price you did not see" failure the expectedPrice
// guard exists to prevent — falling back to one on the client while the server
// still refused would turn a wrong price into a confusing 409 instead of a
// disabled button.

import { useCallback, useEffect, useSyncExternalStore } from "react";

export type StorePrices = {
  /** null until the first successful read — never a default. */
  prices: Record<string, number> | null;
  /** Points per stream, the anchor every price derives from. */
  e: number | null;
  /** Can points be bought here (`currency.purchasable`)? null until the first read. */
  purchasable: boolean | null;
  /** The sponsor clock's earn multiplier (`currency.earn.clockMultiplier`); null until read. */
  clockMultiplier: number | null;
};

const EMPTY: StorePrices = { prices: null, e: null, purchasable: null, clockMultiplier: null };

// One stable object, replaced only when the data actually changes.
// useSyncExternalStore compares snapshots by identity, so returning a fresh
// object per read would re-render forever.
let snapshot: StorePrices = EMPTY;
let fetching = false;
const listeners = new Set<() => void>();

/** Re-fetch the table (mount, window focus). Deduped: a second caller during a
 *  live request is a no-op rather than a second round trip. */
export function refreshStorePrices(): void {
  if (fetching) return;
  fetching = true;
  fetch("/api/store/prices")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { prices?: Record<string, number>; e?: number; purchasable?: unknown; clockMultiplier?: unknown } | null) => {
      // A failed or malformed read is not a price change — keep the last good
      // table rather than blanking the store.
      if (!d?.prices || typeof d.e !== "number") return;
      snapshot = {
        prices: d.prices, e: d.e,
        purchasable: typeof d.purchasable === "boolean" ? d.purchasable : null,
        clockMultiplier: typeof d.clockMultiplier === "number" ? d.clockMultiplier : null,
      };
      for (const fn of listeners) fn();
    })
    .catch(() => {
      /* offline / mid-deploy — keep the last good prices */
    })
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

/** The live price table. `prices` is null until the first read lands; a caller
 *  that charges money must treat null as "cannot buy yet", never as a default. */
export function useStorePrices(): StorePrices {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
  const onFocus = useCallback(() => {
    if (document.visibilityState === "visible") refreshStorePrices();
  }, []);
  useEffect(() => {
    if (snapshot.prices === null) refreshStorePrices();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onFocus]);
  return value;
}

/** One item's price, or null while the table is unknown.
 *  Consumed by useStickerSend and the other spend hooks. */
export function useItemPrice(itemKey: string): number | null {
  const { prices } = useStorePrices();
  return prices?.[itemKey] ?? null;
}
