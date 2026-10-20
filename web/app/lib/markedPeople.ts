"use client";

// The set of people with an open suspicious mark, for the mods-only "Marked" badge beside a name
// in chat. ONE poll per page, started by the page-scoped `useMarkedPolling(isMod)`
// (ChatSidebar / ChatWindow) and only for a mod — a non-mod never fetches, and the route refuses
// them anyway. Rows read the set through `useIsMarked`, which subscribes and never fetches.

import { useEffect, useSyncExternalStore } from "react";

const POLL_MS = 60_000;
type Store = { ids: Set<string>; subs: Set<() => void>; timer: ReturnType<typeof setInterval> | null; users: number };
const store: Store = { ids: new Set(), subs: new Set(), timer: null, users: 0 };

async function refresh(): Promise<void> {
  try {
    const res = await fetch("/api/mod/marks", { cache: "no-store" });
    if (!res.ok) return;
    const j = (await res.json()) as { marks?: { matrixId: string | null; canonicalId: string | null }[] };
    const next = new Set<string>();
    for (const m of j.marks ?? []) { if (m.matrixId) next.add(m.matrixId); if (m.canonicalId) next.add(m.canonicalId); }
    store.ids = next;
    for (const fn of store.subs) fn();
  } catch { /* keep the last set */ }
}

/** Page-scoped: keep the set fresh while a mod has chat open. */
export function useMarkedPolling(isMod: boolean): void {
  useEffect(() => {
    if (!isMod) return;
    store.users++;
    if (!store.timer) { void refresh(); store.timer = setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS); }
    return () => {
      store.users--;
      if (store.users <= 0 && store.timer) { clearInterval(store.timer); store.timer = null; }
    };
  }, [isMod]);
}

const subscribe = (fn: () => void) => { store.subs.add(fn); return () => { store.subs.delete(fn); }; };

/** Per row: is this sender marked? Reads the shared set; never fetches. */
export function useIsMarked(matrixId: string | null | undefined, canonicalId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe,
    () => (!!matrixId && store.ids.has(matrixId)) || (!!canonicalId && store.ids.has(canonicalId)),
    () => false);
}
