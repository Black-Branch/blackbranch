"use client";

import { useEffect } from "react";

// Device-health telemetry for the whole app (app/lib/deviceHealth/reporter.ts).
// Its own component beside ClientErrorReporter, for the same reason that one is: "measure the
// page" must not ride on any other component's early-returns.
//
// The reporter itself loads at IDLE, so it adds nothing to the first-load JS beyond this file
// (loaded eagerly it would exceed the first-load budget). What must happen from the first frame
// happens here: the Resource Timing buffer is raised to 3000 at once, so the reporter's
// `buffered: true` observer still finds every request made before it arrived — the default 250
// would fill on the emote warmer alone.
//
// Mounted in the ROOT layout, but it reports nothing on /overlay/* — the OBS browser sources run
// around the clock on the streaming PC and would drown the viewer data. The check also lives in
// startDeviceHealth so the cadence test can drive it.
export default function DeviceHealthReporter() {
  useEffect(() => {
    if (location.pathname.startsWith("/overlay")) return;
    try { performance.setResourceTimingBufferSize(3000); } catch { /* not supported — fewer entries */ }
    let stop: (() => void) | null = null;
    let cancelled = false;
    const start = () => {
      void import("../lib/deviceHealth/reporter").then(({ startDeviceHealth }) => {
        if (!cancelled) stop = startDeviceHealth();
      }).catch(() => {});
    };
    // Safari has no requestIdleCallback; a short timeout stands in.
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle ? window.requestIdleCallback(start, { timeout: 5000 }) : window.setTimeout(start, 2000);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      stop?.();
    };
  }, []);
  return null;
}
