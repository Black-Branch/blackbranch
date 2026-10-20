"use client";

import { useEffect, useRef } from "react";
import { beatIntervalMs, pageFromPath } from "./presenceState.ts";

// The tab's presence beat: POST /api/presence/beat every 30 s while visible,
// every 60 s while hidden, at once on mount / on returning to the tab / when
// the page or the community flag changes. Separate from the coin heartbeat on
// purpose — that one is a "watching the stream" signal and only runs while
// live; this one runs on every page, live or not.
//
// A 401 (signed out) stands the beat down for the rest of the page life: a
// signed-out visitor costs ONE request per page load, never a loop.

type Opts = {
  /** The Matrix client is running on this tab (community view / Matrix settings mounted). */
  community: boolean;
  pathname: string;
  /** Injected for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
};

let stoodDown = false;
// The last status this tab has learned about, across every beat this page
// life has sent — module-level like `stoodDown`, so a status set in another
// tab (or before this hook remounted) is still "known" on the next beat.
// Starts null: the very first beat's answer always counts as "a change" so a
// tab that opened with a stale assumption (e.g. the community client's
// stored token status) is brought into line at once.
let lastStatus: string | null = null;

/** @test-only usePresenceBeat.render.test.ts mounts the hook repeatedly in one process; the 401 latch and the cross-tab status memory must reset between tests. */
export function __resetPresenceBeatForTests(): void {
  stoodDown = false;
  lastStatus = null;
}

export function usePresenceBeat({ community, pathname, schedule, fetchImpl }: Opts): void {
  // Latest props, readable from a timer callback without re-arming the timer.
  // Written from an effect with no deps array (runs after every render), not
  // during render: eslint's react-hooks/refs treats a render-time ref write
  // as a bug (it can leave a component not updating as expected), even for a
  // ref that, as here, is deliberately excluded from rendering altogether.
  const latest = useRef({ community, pathname });
  useEffect(() => {
    latest.current = { community, pathname };
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const sched = schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const doFetch = fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
    let cancelled = false;
    let timer: unknown = null;

    const beat = () => {
      if (cancelled || stoodDown) return;
      const visible = document.visibilityState === "visible";
      const { community: c, pathname: p } = latest.current;
      void doFetch("/api/presence/beat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: pageFromPath(p), community: c, visible }),
      })
        .then((r) => {
          if (r.status === 401) { stoodDown = true; return; }
          if (!r.ok) return;
          // The beat's own answer carries the CURRENT status: read it and, on a
          // real change, tell every consumer on this tab — otherwise a second
          // open tab that started before an Invisible set elsewhere keeps
          // announcing "online" on its own next /sync and undoes it within one
          // beat interval.
          return r.json().then((data: { status?: unknown }) => {
            const status = data?.status;
            if (typeof status === "string" && status !== lastStatus) {
              lastStatus = status;
              window.dispatchEvent(new CustomEvent("bb:presence-status", { detail: { status } }));
            }
          });
        })
        .catch(() => {});
      if (typeof timer === "number") clearTimeout(timer);
      timer = sched(beat, beatIntervalMs(visible));
    };

    const onVisibility = () => { if (document.visibilityState === "visible") beat(); };
    document.addEventListener("visibilitychange", onVisibility);
    beat();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (typeof timer === "number") clearTimeout(timer);
    };
    // A page or community change re-arms via the effect deps: the first beat of
    // the new effect run reports the new values at once.
  }, [community, pathname, schedule, fetchImpl]);
}
