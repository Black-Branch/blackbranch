"use client";

// The page/sheet back contract: one sentinel for every surface system back
// should close.
//
// The site is a display:standalone PWA with no other history integration:
// without this module, Android back / iOS edge-swipe over a full-screen page
// EXITS THE SITE. One sentinel history entry is armed while ≥1 page-window
// is open; the user's Back pops it, which we translate into a close request
// on the top layer of the SAME dismiss stack Escape uses. CloseWatcher is
// the purpose-built API but is Safari-blocked from Baseline, and
// iOS standalone is exactly where the gesture lives — hence history.
//
// The pushed state MERGES window.history.state: the Next App Router keeps
// its own router state there, and replacing it breaks Back for the whole app.
//
// The state machine itself (the transition table + its injected-history
// type) lives in pageBackSentinelCore.ts — this file wires the ONE
// production instance to the real browser globals and exposes it as a hook.
//
// ?backdebug=1: every wired op also lands in a small ring buffer with
// the machine's post-op snapshot, surfaced by BackDebugOverlay — a back
// failure that only reproduces on a device has to be debugged from that
// device. Zero cost unless the query param is present at first use.

import { useEffect, useRef } from "react";
import { pushDismissLayer, dismissTop } from "./dismissStack.ts";
import { createPageBackSentinel, hasMarkState, MARK } from "./pageBackSentinelCore.ts";

export type BackDebugEvent = {
  t: number;
  ev: string;
  pages: number;
  armed: boolean;
  consuming: boolean;
  pending: boolean;
  /** window.history.length at the time of the event. */
  len: number;
  /** does the CURRENT entry carry the mark? */
  mark: boolean;
};

const DEBUG_CAP = 40;
const debugLog: BackDebugEvent[] = [];
const debugListeners = new Set<() => void>();
 
let debugSeq = 0;

/** Monotonic event counter — the overlay's useSyncExternalStore snapshot.
 *  Length+timestamp is NOT enough once the ring buffer is full: two events
 *  in the same millisecond leave both unchanged and the tail renders one
 *  event stale (5c-r final-review finding 13a). */
export function backDebugVersion(): number {
  return debugSeq;
}

export function backDebugEnabled(): boolean {
  try {
    return window.location.search.includes("backdebug=1");
  } catch {
    return false;
  }
}

/** Read-only view of the ring buffer (newest last). */
export function getBackDebugLog(): readonly BackDebugEvent[] {
  return debugLog;
}

export function subscribeBackDebug(fn: () => void): () => void {
  debugListeners.add(fn);
  return () => debugListeners.delete(fn);
}

let singleton: ReturnType<typeof createPageBackSentinel> | null = null;

function trace(ev: string) {
  if (!singleton || !backDebugEnabled()) return;
  const s = singleton.state();
  debugLog.push({
    t: Date.now(),
    ev,
    pages: s.pages,
    armed: s.armed,
    consuming: s.consuming,
    pending: s.pendingConsume,
    len: window.history.length,
    mark: hasMarkState(window.history.state),
  });
  if (debugLog.length > DEBUG_CAP) debugLog.splice(0, debugLog.length - DEBUG_CAP);
  debugSeq += 1;
  for (const fn of debugListeners) fn();
}

function sentinel() {
  if (!singleton) {
    singleton = createPageBackSentinel(
      {
        push: () => {
          const prior = window.history.state;
          window.history.pushState(
            { ...(typeof prior === "object" && prior !== null ? prior : {}), [MARK]: true },
            "",
            window.location.href
          );
          trace("push");
        },
        back: () => {
          window.history.back();
          trace("back()");
        },
        hasMark: () => hasMarkState(window.history.state),
      },
      dismissTop
    );
    window.addEventListener("popstate", (e) => {
      singleton!.onPopstate(e.state);
      trace(hasMarkState(e.state) ? "pop→mark" : "pop");
    });
  }
  return singleton;
}

/**
 * A page/sheet window's close-request wiring: Escape and system back share
 * ONE handler (back-first ordering — in-card ‹ depth before window close —
 * is the caller's job). Reads the handler through a ref, same law as
 * useEscapeDismiss: inline arrows must not re-register the layer.
 */
export function usePageBack(onCloseRequest: () => void) {
  const ref = useRef(onCloseRequest);
  useEffect(() => { ref.current = onCloseRequest; });
  useEffect(() => {
    const popLayer = pushDismissLayer(() => ref.current());
    const releaseSentinel = sentinel().register();
    trace("register");
    return () => {
      popLayer();
      releaseSentinel();
      trace("release");
    };
  }, []);
}
