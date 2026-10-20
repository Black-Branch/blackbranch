import { useEffect, useState, useSyncExternalStore } from "react";
import { getJson } from "@/app/lib/http";
import type { HomePayload } from "@/app/lib/homePayload";
import { readHomeStore, writeHomeStore, subscribeHomeStore } from "@/app/lib/homeStore";

// Client poll for GET /api/home. Mirrors useRssFeed: refresh on an interval
// while `active` and the tab is visible. `active` is the host's "this pane is
// the one on screen" — a pager approach-mount must not poll.
//
// The body on screen is the NEWER of what this browser remembers
// (homeStore — memory, then sessionStorage) and the server's copy (`initial`,
// the same on the server and during hydration, so there is no mismatch), else
// nothing (the widgets read as loading). Newer by generatedAt, not "remembered
// first": a reload carries a fresh server body, and a remembered one from
// minutes ago must not replace it for the round trip until the fetch lands.
// A fetch only refreshes.
// "bb:home-refresh" is a manual refetch hook (tests, and later the widgets'
// own "refresh" affordance); the interval is the normal path.
const POLL_MS = 60_000;
// Not exported: nothing outside this hook fires it yet, and an unreferenced
// export fails check-orphans. Tests dispatch the literal.
const HOME_REFRESH_EVENT = "bb:home-refresh";
const nothing = () => null;

/** The more recently built of two bodies; an unparseable stamp loses. */
function newer(a: HomePayload | null, b: HomePayload | null): HomePayload | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.generatedAt), tb = Date.parse(b.generatedAt);
  if (Number.isNaN(tb)) return a;
  if (Number.isNaN(ta)) return b;
  return tb > ta ? b : a;
}

export function useHomeData(active: boolean, initial: HomePayload | null = null): { data: HomePayload | null; loading: boolean; error: boolean } {
  const remembered = useSyncExternalStore(subscribeHomeStore, readHomeStore, nothing);
  const data = newer(remembered, initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const body = await getJson<HomePayload>("/api/home");
        if (!cancelled) { writeHomeStore(body); setError(false); }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    const onRefresh = () => { load(); };
    window.addEventListener(HOME_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener(HOME_REFRESH_EVENT, onRefresh);
    };
  }, [active]);

  return { data, loading, error };
}
