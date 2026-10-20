"use client";

// Wires the player debug log (app/lib/playerDebug.ts) to the player box and the page around it.
// Does nothing at all unless the per-device switch is on. MEASUREMENT ONLY: nothing here touches
// playback.
import { useEffect, type RefObject } from "react";
import { PlayerDebugLog, PLAYER_DEBUG_KEY, readPlayerDebugSwitch } from "@/app/lib/playerDebug";
import { reportClientError } from "@/app/lib/clientError";
import { lsGet, lsRemove, lsSet } from "@/app/lib/safeLocalStorage";

let log: PlayerDebugLog | null = null;
let mounts = 0;

function debugLog(): PlayerDebugLog | null {
  if (log) return log;
  if (typeof window === "undefined") return null;
  const sw = readPlayerDebugSwitch(window.location.search, lsGet(PLAYER_DEBUG_KEY));
  if (sw.store === "1") lsSet(PLAYER_DEBUG_KEY, "1");
  else if (sw.store === null) lsRemove(PLAYER_DEBUG_KEY);
  if (!sw.on) return null;
  log = new PlayerDebugLog();
  (window as unknown as { __playerDebug?: PlayerDebugLog }).__playerDebug = log;
  return log;
}

function record(l: PlayerDebugLog, kind: string, detail = "") {
  const report = l.push(kind, detail);
  if (!report) return;
  const err = new Error(report.message);
  err.stack = report.stack;
  reportClientError("player", err);
}

const MEDIA_EVENTS = ["loadstart", "emptied", "play", "playing", "pause", "waiting", "stalled", "ended", "error", "volumechange"] as const;

/** `src` is what the box is showing (playerSrcFor) — logged on every change. */
export function usePlayerDebug(boxRef: RefObject<HTMLElement | null>, src: string): void {
  useEffect(() => {
    const l = debugLog();
    if (l) record(l, "src", src);
  }, [src]);

  useEffect(() => {
    const l = debugLog();
    const box = boxRef.current;
    if (!l || !box) return;
    mounts += 1;
    record(l, mounts > 1 ? "remount" : "mount", `#${mounts}`);

    const muted = new WeakMap<EventTarget, boolean>();
    const loads = new WeakMap<EventTarget, number>();
    const onMedia = (e: Event) => {
      const v = e.target as HTMLMediaElement;
      if (!(v instanceof HTMLMediaElement)) return;
      if (e.type === "volumechange") {
        const was = muted.get(v);
        muted.set(v, v.muted);
        if (was === v.muted) { record(l, "volume", v.volume.toFixed(2)); return; }
        // An element's first volumechange is its starting state, not a change anyone made.
        if (was === undefined) { record(l, v.muted ? "starts muted" : "starts unmuted"); return; }
        record(l, v.muted ? "muted" : "unmuted");
        return;
      }
      if (!muted.has(v)) muted.set(v, v.muted);
      record(l, e.type, `t=${v.currentTime.toFixed(1)} ready=${v.readyState}`);
    };
    const onLoad = (e: Event) => {
      const f = e.target;
      if (!(f instanceof HTMLIFrameElement)) return;
      const n = (loads.get(f) ?? 0) + 1;
      loads.set(f, n);
      record(l, n > 1 ? "iframe-reload" : "iframe-load", f.src.split("?")[0] ?? "");
    };
    // Media and load events do not bubble; a CAPTURE listener on the box still sees them.
    for (const t of MEDIA_EVENTS) box.addEventListener(t, onMedia, true);
    box.addEventListener("load", onLoad, true);

    const onTap = () => l.interaction();
    const onVisibility = () => record(l, "visibility", document.visibilityState);
    const onPageHide = () => record(l, "pagehide");
    const onPageShow = (e: PageTransitionEvent) => record(l, "pageshow", e.persisted ? "from back-forward cache" : "");
    let lastSize = "";
    const onResize = () => {
      const s = `${window.innerWidth}x${window.innerHeight}`;
      if (s !== lastSize) { lastSize = s; record(l, "resize", s); }
    };
    // Another tab or window changed a stored setting (the key only, never the value).
    const onStorage = (e: StorageEvent) => record(l, "storage", e.key ?? "(all)");
    document.addEventListener("pointerdown", onTap, true);
    document.addEventListener("keydown", onTap, true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("resize", onResize);
    window.addEventListener("storage", onStorage);
    return () => {
      record(l, "unmount");
      for (const t of MEDIA_EVENTS) box.removeEventListener(t, onMedia, true);
      box.removeEventListener("load", onLoad, true);
      document.removeEventListener("pointerdown", onTap, true);
      document.removeEventListener("keydown", onTap, true);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("storage", onStorage);
    };
  }, [boxRef]);
}
