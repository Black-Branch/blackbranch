"use client";
// The viewer's OWN per-platform public ids (GET /api/me/public-ids) — what "is this line mine?"
// compares now that chat lines carry no canonical id. One fetch per page, shared by every reader;
// signed out (401) or failed = no ids, and the chat simply styles nothing as theirs on a platform
// (their site lines still match by Matrix id). A failed load is retried on the next subscriber.
import { useSyncExternalStore } from "react";

const EMPTY: ReadonlySet<string> = new Set();
let ids: ReadonlySet<string> = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  loading ??= fetch("/api/me/public-ids", { cache: "no-store" })
    .then(async (r) => {
      if (r.status === 401) return;
      if (!r.ok) { loading = null; return; }
      const d = (await r.json()) as { ids?: unknown };
      const got = Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : [];
      ids = new Set(got);
      for (const l of listeners) l();
    })
    .catch(() => { loading = null; });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  load();
  return () => { listeners.delete(cb); };
}

/** The viewer's own public ids; re-renders once they arrive. */
export function useOwnPublicIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => ids, () => EMPTY);
}
