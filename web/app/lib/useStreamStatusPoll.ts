import { useState, useRef, useEffect } from "react";
import { siteName } from "./siteName.ts";
import type { RefObject } from "react";
import { getJson } from "./http";
import { keepIfEqual } from "./stableState";
import { edgeTab, type PlayerState } from "./playerSource";
import { tabId } from "./tabId";
import type { CommunityStatus, LoopVideo } from "./streamView";

/** Kept in step with StreamView's `tab` state — see app/lib/playerSource.ts. */
export type PlayerTab = PlayerState["tab"];

// Poll live status every 30s; also fires immediately on mount. Edge-detects
// live/community presence so the tab only auto-switches on the transition
// (offline→live shows the stream; live→offline goes to `offlineTab`) — never
// on every poll, which would yank a viewer out of a tab they deliberately
// chose.
export function useStreamStatusPoll(
  isLive: boolean,
  viewerCount: number | null,
  initialYtVideoId: string | null,
  setTab: (fn: (prev: PlayerTab) => PlayerTab) => void,
  /** The source this tab is watching right now, for the per-source census
   *  (app/lib/sourceCensus.ts). A REF, not a value: this poll runs on one
   *  interval for the page's lifetime with a []-dep closure, so a value passed
   *  by argument would be frozen at the first render — the same stale-closure
   *  problem the functional `setTab` updater already solves below. Empty
   *  string means "nothing known yet" (see the poll below) — that poll omits
   *  the census params instead of voting on a guess. */
  sourceRef: RefObject<string>,
  /** Where "everything went off" lands: the first registered fallback, else "live" (playerSource.edgeTab). */
  offlineTab: PlayerTab,
) {
  const [live, setLive] = useState(isLive);
  // The live YouTube broadcast id (v115) — seeded by the server render, kept
  // fresh by the poll. It can take a few minutes to arrive after going live
  // (ingest's idle cadence + debounce), which flips the YouTube source once;
  // null while offline.
  const [ytVideoId, setYtVideoId] = useState<string | null>(initialYtVideoId);
  const [community, setCommunity] = useState<CommunityStatus | null>(null);
  // The community fallback playlist (v77). Only ever populated by the server
  // when nobody is live, which is exactly when the player uses it.
  const [loopVideos, setLoopVideos] = useState<LoopVideo[]>([]);
  // Live viewer total — seeded by the server render, refreshed by the 30s
  // status poll below so the "N watching" count tracks the stream instead of
  // freezing at page-load. Kept when a poll omits the number (snapshot gap).
  const [liveViewers, setLiveViewers] = useState<number | null>(viewerCount);
  const liveWasOn = useRef(isLive);
  const primaryWasOn = useRef(isLive);

  // The tab title carries the one fact a backgrounded viewer wants — is the
  // stream on. Owned here because this hook owns live state,
  // and nothing else in the app writes document.title (the reason a plain
  // assignment is safe).
  useEffect(() => {
    document.title = live ? `🔴 LIVE — ${siteName()}` : siteName();
  }, [live]);

  useEffect(() => {
    const poll = () =>
      getJson<{ live?: boolean; community?: CommunityStatus | null; viewers?: number | null;
                loopVideos?: LoopVideo[]; ytVideoId?: string | null }>(
        // The census rides the poll that already runs — no new timer, no new
        // request. The server validates both values against a closed vocabulary.
        // An empty ref means the caller has nothing honest to report yet (see
        // StreamView's sourceRef seed) — that poll fetches the bare endpoint
        // and casts no census vote, rather than voting "none" on a guess.
        sourceRef.current
          ? `/api/stream/status?src=${encodeURIComponent(sourceRef.current)}&tab=${encodeURIComponent(tabId())}`
          : "/api/stream/status",
      )
        .then((d) => {
          setLive(!!d?.live);
          setYtVideoId(d?.live && typeof d.ytVideoId === "string" && d.ytVideoId ? d.ytVideoId : null);
          // keepIfEqual: these two are objects, so a plain set would mint a new
          // identity every 30s and re-render StreamView's whole subtree for a
          // payload that almost never changes. (live/viewers are primitives —
          // React bails on those by itself.)
          setCommunity(keepIfEqual(d?.community ?? null));
          setLoopVideos(keepIfEqual(d?.loopVideos ?? []));
          if (!d?.live) setLiveViewers(null);
          else if (typeof d.viewers === "number") setLiveViewers(d.viewers);
          // Only an EDGE moves the tab (playerSource.edgeTab): a viewer who chose
          // a fallback mid-stream is not dragged back every poll. The streamer going
          // live takes over for everyone, a fallback included (StreamPlayerArea
          // unmounts a fallback's player when the tab leaves it) — and that edge is
          // keyed on `live` itself, because a configured loop playlist keeps
          // "something is on" true while they are offline. Everything going off →
          // the offline tab. The streamer ending while a community stream stays on
          // is not an edge: their sources leave the row and the source fallback
          // moves the viewer. (Functional updater so the []-dep effect never reads
          // a stale tab.)
          const primaryOn = !!(d?.live || d?.community || d?.loopVideos?.length);
          const next = edgeTab(
            { live: liveWasOn.current, primaryOn: primaryWasOn.current },
            { live: !!d?.live, primaryOn },
            offlineTab,
          );
          if (next) setTab(() => next);
          liveWasOn.current = !!d?.live;
          primaryWasOn.current = primaryOn;
        })
        .catch(() => {});
    poll();
    // A backgrounded tab does NOT skip the poll: "nothing it learns is
    // visible" is false because of the LIVE tab title (above) — the title is
    // exactly what a hidden tab shows. One tiny status GET per 30s is the
    // price of the going-live signal reaching pinned tabs. The
    // visibility-return poll below stays: the tab auto-switch is
    // edge-detected, so returning viewers must not wait out the interval.
    const id = setInterval(poll, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one interval for the page's lifetime. offlineTab is fixed by the build (the installed plugin); setTab is a prop the rule cannot see through; listing it would tear down and re-arm the 30s timer on every parent render, so a re-rendering page would never actually reach a poll. The functional updater (see above) is what keeps the []-dep closure from reading a stale tab
  }, []);

  return { live, community, liveViewers, loopVideos, ytVideoId };
}
