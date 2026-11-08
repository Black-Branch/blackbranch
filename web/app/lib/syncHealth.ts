import { useSyncExternalStore } from "react";

// The community's connection health, fed by the Matrix client's sync listener
// (MatrixClientContext). Its own tiny store, not context state: a context value
// change would re-render every consumer of the client, and only the pill reads this.
//
// "Reconnecting" is an infrastructure notice (ADR 0110), so it is quiet and
// late: it shows only after the loss has lasted RECONNECTING_AFTER_MS. The SDK
// reports the first failed /sync as RECONNECTING and a failed keep-alive (2-7 s
// later, then every 5-10 s) as ERROR; the loss starts at the first of them, so
// either starts the clock and a repeat never restarts it. A long-poll the
// server merely dropped recovers within one keep-alive, well inside the 10 s.
// A landed sync (SYNCING / PREPARED) clears it; CATCHUP is not yet a landed
// sync. Before the first PREPARED the boot checklist owns the screen, so a
// failure then changes nothing here.

type SyncHealth = "ok" | "reconnecting";

const RECONNECTING_AFTER_MS = 10_000;

let health: SyncHealth = "ok";
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(next: SyncHealth) {
  if (next === health) return;
  health = next;
  for (const l of listeners) l();
}

function clear() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  set("ok");
}

export function setSyncState(state: string, prepared: boolean): void {
  if (state === "ERROR" || state === "RECONNECTING") {
    if (!prepared) return clear();
    if (timer === null && health === "ok") {
      timer = setTimeout(() => { timer = null; set("reconnecting"); }, RECONNECTING_AFTER_MS);
    }
    return;
  }
  if (state === "CATCHUP") return;
  clear();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const read = () => health;
const readServer = (): SyncHealth => "ok";

export function useSyncHealth(): SyncHealth {
  return useSyncExternalStore(subscribe, read, readServer);
}
