"use client";
// Reactive, SCOPE-AWARE read of one setting's stored string (settingGet honours
// the ov: keyspace on /chat and the OBS overlay — useLocalStorageString does
// not). For the few settings that change what React renders (timestamp format,
// animated emotes). Read it once at the LIST level and pass it down as a prop:
// 80 rows must not each subscribe.
import { useCallback, useSyncExternalStore } from "react";
import { settingGet } from "./settingsRegistry";

export function useSetting(lsKey: string): string | null {
  const subscribe = useCallback((cb: () => void) => {
    const onSetting = (e: Event) => { if ((e as CustomEvent).detail === lsKey) cb(); };
    window.addEventListener("bb:setting", onSetting);
    window.addEventListener("bb:settings-hydrated", cb);
    return () => {
      window.removeEventListener("bb:setting", onSetting);
      window.removeEventListener("bb:settings-hydrated", cb);
    };
  }, [lsKey]);
  return useSyncExternalStore(subscribe, () => settingGet(lsKey), () => null);
}

/** A number that changes once a minute while `on` — lets memoized "2m ago" rows re-render. */
export function useMinuteTick(on: boolean): number {
  const subscribe = useCallback((cb: () => void) => {
    if (!on) return () => {};
    const id = window.setInterval(cb, 60_000);
    return () => window.clearInterval(id);
  }, [on]);
  return useSyncExternalStore(subscribe, () => (on ? Math.floor(Date.now() / 60_000) : 0), () => 0);
}
