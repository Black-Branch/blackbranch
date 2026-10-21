"use client";
// A moderator's view of who a chat line is: its canonical id and linked site account, resolved
// from the line's public id (POST /api/mod/identity/resolve). Chat lines carry only per-platform
// public ids; the moderation tools act by canonical and site account.
//
// Resolved when the line is RENDERED for a moderator, not when a control is clicked: every id on
// screen joins one batched request per tick, and the answer is cached for the page, so a mod's
// controls already hold their target by the time they are used — never a wait on the click.
// A moderator's history page carries the canonical already; that wins and costs nothing.
import { useEffect, useSyncExternalStore } from "react";

export type ModIds = { canonicalId: string | null; matrixId: string | null };

const cache = new Map<string, ModIds | null>();   // publicId → ids (null = does not resolve)
const queued = new Set<string>();
let flushing = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

function flush(): void {
  flushing = false;
  const ids = [...queued].slice(0, 200);
  for (const id of ids) queued.delete(id);
  if (ids.length === 0) return;
  fetch("/api/mod/identity/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d: { ids?: Record<string, ModIds> }) => {
      for (const id of ids) cache.set(id, d.ids?.[id] ?? null);
      emit();
    })
    .catch(() => { /* not cached: the next render of that line asks again */ })
    .finally(() => { if (queued.size) schedule(); });
}
function schedule(): void {
  if (flushing) return;
  flushing = true;
  setTimeout(flush, 0);
}

/** Ask for one public id (no-op when cached or already asked). */
function want(id: string): void {
  if (cache.has(id) || queued.has(id)) return;
  queued.add(id);
  schedule();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The ids a moderator's controls act on for this line; `enabled` false (not a mod) asks nothing
 *  and answers only what the line itself carries. */
export function useModIds(
  msg: { publicId?: string | null; canonicalId?: string | null; matrixId?: string | null },
  enabled: boolean,
): ModIds {
  const pid = enabled && !msg.canonicalId ? msg.publicId ?? null : null;
  useEffect(() => { if (pid) want(pid); }, [pid]);
  const hit = useSyncExternalStore(subscribe, () => (pid ? cache.get(pid) ?? null : null), () => null);
  return {
    canonicalId: msg.canonicalId ?? hit?.canonicalId ?? null,
    matrixId: msg.matrixId ?? hit?.matrixId ?? null,
  };
}

/** The cached answer for one id, outside React (the mod panel's followed frames); null when not
 *  resolved yet, and it asks. */
export function modIdsNow(publicId: string | null | undefined): ModIds | null {
  if (!publicId) return null;
  const hit = cache.get(publicId);
  if (hit === undefined) want(publicId);
  return hit ?? null;
}
