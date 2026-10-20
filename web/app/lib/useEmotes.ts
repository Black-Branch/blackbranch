"use client";

import { useEffect, useMemo, useState } from "react";
import { lsGetJSON, lsSetJSON } from "@/app/lib/safeLocalStorage";
import { getJson } from "@/app/lib/http";
import { useClientValue } from "@/app/lib/useClientState";
import { warmEmotes } from "@/app/lib/emoteWarmer";
import { emoteReadiness } from "./emoteReadiness";

export type { EmoteInfo, EmoteMap } from "./emoteMap";
import type { EmoteMap } from "./emoteMap";

const CACHE_KEY = "emoteManifest_v5";
const EMPTY: EmoteMap = {};

let freshFetch: Promise<EmoteMap | null> | null = null;
// Parsed-once localStorage manifest (undefined = not read yet). Cached at module
// level so the useSyncExternalStore snapshot below is referentially stable.
let cachedManifest: EmoteMap | null | undefined;

function readCachedManifest(): EmoteMap | null {
  if (cachedManifest === undefined) {
    cachedManifest = lsGetJSON<EmoteMap | null>(CACHE_KEY, null);
  }
  return cachedManifest;
}

/** The catalog as it stands — the fresh fetch once it landed, else the cached one — for a
 *  reader outside React (the terminal's chat rows). Empty before either. */
// @parked plugin API: a console beside the chat (the owner plugin's terminal, app/(owner)/_terminal) reads or drives the chat through it
export function currentEmotes(): EmoteMap {
  return readCachedManifest() ?? EMPTY;
}

function fetchFresh(): Promise<EmoteMap | null> {
  if (!freshFetch) {
    emoteReadiness.advance("catalog", "active");
    freshFetch = getJson<EmoteMap>("/api/emotes")
      .then((data) => {
        // An empty manifest is not a failure — the site works without emotes.
        emoteReadiness.advance("catalog", "done");
        if (!data || Object.keys(data).length === 0) return null;
        lsSetJSON(CACHE_KEY, data);
        cachedManifest = data;
        return data;
      })
      // A THROWN fetch reads as done too — same as the empty manifest above,
      // same as `personal` (usePersonalEmotes.ts). The site works without
      // emotes and this stage's composers are community boots, whose subject
      // is the client: an "error" here put the whole pane in the failed phase
      // behind a Try again that could never clear it, because `retry()` only
      // restarts Matrix while `freshFetch` is memoised for the page's life. A
      // genuinely broken catalog stays visible where it is felt — the picker.
      .catch(() => { emoteReadiness.advance("catalog", "done"); return null; });
  }
  return freshFetch;
}

// `initial` — the emotes the server page inlined for the rows it rendered
// (emoteSubset.ts): the manifest slice those rows need, on the page before any
// script runs, so the seeded rows render their <img>s at SSR and the browser
// fetches them from the HTML. It is merged UNDER the cached/fresh manifest
// rather than dropped once one lands: a stale localStorage copy that predates
// a new emote would otherwise un-render it for the moment until the fresh
// fetch arrives.
export function useEmotes(initial?: EmoteMap): EmoteMap {
  // Cached manifest renders immediately after hydration (empty during SSR);
  // the fresh fetch replaces it when it lands.
  const cached = useClientValue(readCachedManifest, null);
  const [fresh, setFresh] = useState<EmoteMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Warm the CACHED manifest's HOT set immediately on mount — returning visitors
    // have it in localStorage synchronously, so the most-used emotes start at t=0
    // instead of waiting out a network round-trip. The tail waits for the fresh
    // manifest (it carries the usage ranks — see warmEmotes). warmEmotes dedupes, so
    // the fresh call below only pays for what the seed call did not start.
    const seed = readCachedManifest();
    if (seed) warmEmotes(seed, false);
    fetchFresh().then((data) => {
      if (data && !cancelled) {
        setFresh(data);
        warmEmotes(data); // warm any delta the fresh manifest added over the cache
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const base = fresh ?? cached;
  return useMemo(() => {
    if (!initial) return base ?? EMPTY;
    if (!base) return initial;
    return { ...initial, ...base };
  }, [base, initial]);
}
