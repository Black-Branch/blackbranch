// The module rule's server half: which modules this install shows right now. SERVER ONLY.
//
// Public pages ask on every render, so stream-api's GET /config is read at most once per
// SNAPSHOT_MS, by one request at a time, with a short timeout; a failed read keeps the last good
// snapshot (and before the first, moduleRunning falls back to web's own reading).

import { streamApiFetch } from "./streamApi.ts";
import { instanceBool, instanceState } from "./instanceConfigServer.ts";
import { MODULES } from "./instanceSchema.generated.mjs";
import { keyInstalled } from "./plugins/installed.ts";
import { moduleRunning } from "./moduleRunning.ts";
import type { StreamApiSnapshot } from "./instanceAdminView.ts";

const SNAPSHOT_MS = 30_000;
const TIMEOUT_MS = 1_500;

type Cache = { snap: StreamApiSnapshot | null; at: number; inflight: Promise<void> | null };
const g = globalThis as typeof globalThis & { __servingSnapshot?: Cache };
const cache: Cache = (g.__servingSnapshot ??= { snap: null, at: 0, inflight: null });

/** stream-api's GET /config, at most SNAPSHOT_MS old when stream-api answers; null before the first
 *  answer. Never throws. The legal page reads the same snapshot. */
export async function servingSnapshot(): Promise<StreamApiSnapshot | null> {
  if (Date.now() - cache.at >= SNAPSHOT_MS) {
    cache.inflight ??= (async () => {
      try {
        const res = await streamApiFetch("/config", { cache: "no-store" }, TIMEOUT_MS);
        if (res.ok) cache.snap = (await res.json()) as StreamApiSnapshot;
      } catch { /* keep the last good snapshot */ }
      cache.at = Date.now();
      cache.inflight = null;
    })();
    await cache.inflight;
  }
  return cache.snap;
}

/** Whether a module is shown on this install: installed (an owner module needs the plugin) and on
 *  as the process that serves it runs it. Until web's settings have loaded once, web's own reading
 *  counts as on — a database blip must not take away a part nobody switched off. */
export async function modulesShown(): Promise<Record<string, boolean>> {
  const snap = await servingSnapshot();
  const loaded = instanceState().loaded;
  return Object.fromEntries(MODULES.map((m) => [
    m.id,
    keyInstalled(`modules.${m.id}`) && moduleRunning(m, snap, loaded ? instanceBool(`modules.${m.id}`) : true),
  ]));
}

/** The ids of the modules not shown. */
export async function modulesOff(): Promise<string[]> {
  const shown = await modulesShown();
  return MODULES.filter((m) => !shown[m.id]).map((m) => m.id);
}
