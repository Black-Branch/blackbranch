"use client";

// ?backdebug=1 — the on-device back-sentinel probe (a build with the debug switches only: debugFlags.ts).
//
// Back-gesture failures (a back swipe exiting the PWA with a card open) can
// depend on the device's browser and not reproduce off-device, so, like
// ?kbdebug=1, this collects data from the failing device itself. The strip
// streams the sentinel ring buffer (pageBackSentinel) plus the live machine
// snapshot. It mounts outside #app-shell so a page
// window's inert can never disable it, renders nothing without the query
// param, and takes no pointer events.

import { useSyncExternalStore } from "react";
import {
  backDebugEnabled,
  backDebugVersion,
  getBackDebugLog,
  subscribeBackDebug,
} from "@/app/lib/chrome/pageBackSentinel";
import { DEBUG_FLAGS_ON } from "@/app/lib/debugFlags";

export function BackDebugOverlay() {
  // The log array is mutated in place; the monotonic event counter is the
  // snapshot (a length+timestamp pair goes stale once the ring is full and
  // two events share a millisecond).
  const version = useSyncExternalStore(
    subscribeBackDebug,
    () => String(backDebugVersion()),
    () => "ssr"
  );
  if (!DEBUG_FLAGS_ON || version === "ssr" || !backDebugEnabled()) return null;
  const log = getBackDebugLog();
  const tail = log.slice(-8);
  return (
    <div
      aria-hidden="true"
      className="fixed left-1 top-1 rounded bg-canvas/90 p-1 font-mono text-3xs leading-tight text-body"
      style={{ zIndex: 400, pointerEvents: "none", maxWidth: "min(94vw, 340px)" }}
    >
      {tail.length === 0 ? (
        <div>backdebug armed — no sentinel events yet</div>
      ) : (
        tail.map((e, i) => (
          <div key={`${e.t}-${i}`}>
            {new Date(e.t).toISOString().slice(14, 23)} {e.ev} p{e.pages}{" "}
            {e.armed ? "A" : "a"}
            {e.consuming ? "C" : "c"}
            {e.pending ? "P" : "p"} len{e.len} {e.mark ? "M" : "·"}
          </div>
        ))
      )}
    </div>
  );
}
