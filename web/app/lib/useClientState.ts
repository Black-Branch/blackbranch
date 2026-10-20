"use client";

// Hydration-safe reads of browser-only state (localStorage, window.*).
//
// The old idiom — render an SSR default, then correct it with setState inside a
// mount effect — triggers a full cascading re-render and is flagged by
// react-hooks/set-state-in-effect. `useSyncExternalStore` is the sanctioned
// replacement: the server snapshot renders during SSR/hydration, then React
// swaps in the client snapshot without a state-update pass.

import { useCallback, useSyncExternalStore } from "react";
import { lsGet, lsSet } from "./safeLocalStorage";
import { wsGet, wsSet, wsPin } from "./windowScoped";

const noopSubscribe = () => () => {};

/**
 * A value that exists only in the browser (e.g. `window.location.hostname`).
 * Renders `serverValue` during SSR/hydration, the live value after.
 * `getSnapshot` must return a primitive or cached object (it runs every render).
 */
export function useClientValue<T>(getSnapshot: () => T, serverValue: T): T {
  return useSyncExternalStore(noopSubscribe, getSnapshot, () => serverValue);
}

// Same-tab subscribers per localStorage key. The native `storage` event only
// fires in OTHER tabs, so writes through `useLocalStorageString` notify local
// subscribers explicitly (and cross-tab updates still arrive via the event).
const lsListeners = new Map<string, Set<() => void>>();

/**
 * localStorage-backed string state, hydration-safe and shared across all
 * subscribers of the same key (same tab via the registry, other tabs via the
 * `storage` event). Returns `null` on the server and when the key is absent.
 */
export function useLocalStorageString(
  key: string
): [string | null, (value: string) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = lsListeners.get(key);
      if (!set) {
        set = new Set();
        lsListeners.set(key, set);
      }
      set.add(cb);
      const onStorage = (e: StorageEvent) => {
        // key == null covers storage.clear() AND the app's legacy untargeted
        // `window.dispatchEvent(new Event("storage"))` same-tab refresh nudge.
        if (e.key == null || e.key === key) cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key]
  );
  const value = useSyncExternalStore(subscribe, () => lsGet(key), () => null);
  const setValue = useCallback(
    (v: string) => {
      lsSet(key, v);
      lsListeners.get(key)?.forEach((fn) => fn());
    },
    [key]
  );
  return [value, setValue];
}

// Same-window subscribers per key. Deliberately a SEPARATE registry from
// `lsListeners`: these two hooks are the two halves of a distinction that used
// to not exist (roaming preference vs per-window view state), and sharing a
// registry would let a preference write wake a window-scoped reader.
const wsListeners = new Map<string, Set<() => void>>();

/**
 * Per-window state that still remembers across sessions — drop-in replacement
 * for `useLocalStorageString` for anything that is VIEW STATE rather than a
 * preference. See windowScoped.ts for the semantics and the bug behind them.
 *
 * The rule of thumb for choosing between them: *would you be surprised if
 * changing this in one window changed it in another?* Your username colour, no
 * — that should follow you. Which tab you're looking at, or who your next
 * message goes to, yes.
 */
export function useWindowState(
  key: string
): [string | null, (value: string) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      // Pin here rather than inside the snapshot: `subscribe` runs at effect
      // time, so this commits the seed without writing during render. Between
      // first render and this call the snapshot returns the same seed value,
      // so there is no flicker.
      wsPin(key);
      let set = wsListeners.get(key);
      if (!set) {
        set = new Set();
        wsListeners.set(key, set);
      }
      set.add(cb);
      // No `window.addEventListener("storage", …)` — that event is precisely
      // the cross-window channel this hook exists to stay off. Its absence is
      // the feature, not an omission.
      return () => {
        set.delete(cb);
      };
    },
    [key]
  );
  const value = useSyncExternalStore(subscribe, () => wsGet(key), () => null);
  const setValue = useCallback(
    (v: string) => {
      wsSet(key, v);
      wsListeners.get(key)?.forEach((fn) => fn());
    },
    [key]
  );
  return [value, setValue];
}
