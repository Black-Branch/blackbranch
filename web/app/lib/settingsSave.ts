// The Appearance panel's account sync: a debounced save that is FLUSHED, never
// dropped, when the panel closes.
//
// A change is written to localStorage at once and to the account a moment later
// (one request per burst of slider movement, not one per pixel). Cancelling that
// pending save on close lost the change on every other device; closing the panel
// within the debounce now sends it immediately instead.
//
// One saver per tab, outside the component, so a save that fails after the panel
// has closed is still there — and still retryable — when it opens again.
import { useSyncExternalStore } from "react";
import { postJson } from "./http";
import { collectLocalSettings } from "./settingsKeys";
import { deviceClass } from "./deviceClass";

/**
 * @test-only exported so settingsSave.test.ts advances its mock clock by THIS
 * number, not a copy of it that drifts when the debounce changes.
 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 800;

type SaverState = "idle" | "pending" | "saving" | "failed";

/**
 * @test-only exported so settingsSave.test.ts drives a saver with a stub `save`
 * and node's mock timers; the app uses the one instance below.
 */
export function createSettingsSaver(save: () => Promise<boolean>, delayMs = SETTINGS_SAVE_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: SaverState = "idle";
  let inflight: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const set = (s: SaverState) => { state = s; for (const fn of listeners) fn(); };

  const run = async (): Promise<boolean> => {
    timer = null;
    set("saving");
    const p = save().catch(() => false);
    inflight = p;
    const ok = await p;
    if (inflight === p) inflight = null;
    // A newer change scheduled while this one was in flight keeps its own state.
    if (state === "saving") set(ok ? "idle" : "failed");
    return ok;
  };

  return {
    /** A setting changed: (re)start the debounce. */
    schedule(): void {
      if (timer) clearTimeout(timer);
      set("pending");
      timer = setTimeout(() => { void run(); }, delayMs);
    },
    /** Send a pending (or failed) save NOW. Resolves true when nothing was owed. */
    flush(): Promise<boolean> {
      if (timer) { clearTimeout(timer); return run(); }
      if (state === "failed") return run();
      return inflight ?? Promise.resolve(true);
    },
    state: () => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

const saver = createSettingsSaver(async () => {
  const res = await postJson(`/api/me/settings?device_class=${deviceClass()}`, { settings: collectLocalSettings() }, "PUT");
  return res.ok;
});

export const scheduleSettingsSave = saver.schedule;
export const flushSettingsSave = saver.flush;

/** "failed" while the last account save did not land — the panel offers a retry. */
export function useSettingsSaveState(): SaverState {
  return useSyncExternalStore(saver.subscribe, saver.state, () => "idle");
}
