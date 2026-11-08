import type { LoopVideo } from "./streamView";
// Single source of truth for "who is featured right now" + streamer-live takeover.
// Used by GET /api/stream/status (frontend video embed + the stream-ingest relay
// controller) AND by /api/chat/send (to route outbound chat to the community streamer
// a viewer watches). Selection: streamer live → takeover (community:null); else the
// community slot as the background refresher last read it (communityLive.ts) — this
// loader reads no platform itself.

import pool from "@/lib/db";
import { createTtlCache } from "./ttlCache";
import { streamApiFetch } from "@/app/lib/streamApi";
import type { PublicSnapshot } from "./platformLiveness.generated.mjs";
import { livenessOf } from "./streamLiveness.ts";
import { communityAnswer, communitySnapshot } from "./communityLive.ts";

export type CommunityStatus = {
  /** The entry's identity in `communities` and in a send's `community`: its YouTube channel id, else
      `tw:<twitch login>`. */
  key: string;
  display_name: string;
  /** null for an entry featured from Twitch alone. */
  youtube_channel_id: string | null;
  /** The live video id when the scrape found one. Not embedded by the client
      directly: it is the `id` of the YouTube entry in `sources`, and that is
      what the player embeds — a video id, never the live_stream?channel= form,
      which shows "Video unavailable" for many channels. */
  video_id: string | null;
  stream_title: string;
  avatar_url: string | null;
  /** The other platform this featured streamer carries.
      This is OUTBOUND-only: /api/chat/send resolves it server-side to
      route a viewer's cross-post to the featured streamer's own channel (and to
      409 rather than silently posting into the streamer's). Nothing mirrors a
      guest chat INTO our feed. */
  twitch_login: string | null;
  /** Video sources the viewer can switch between (like the main-stream
      sp/yt/tw dots), built from the platforms this streamer carries with their
      per-platform flag on. `id` is the platform handle / video id the embed
      needs. Always includes at least the live source (YouTube's, or Twitch's
      for an entry live on Twitch only). */
  sources: { platform: "youtube" | "twitch"; id: string }[];
  /** The install's own scheduled YouTube stream (its countdown plays, 0134 E4); null for a live entry.
      `startsAt` is null when the page names no start. */
  scheduled: { startsAt: number | null } | null;
};

export type StreamStatus = {
  live: boolean;
  community: CommunityStatus | null;
  /** Every community entry the viewer may choose: the featured one first, then priority order.
      Empty while the streamer is live, and on a degraded load. */
  communities: CommunityStatus[];
  /** The community player's fallback playlist, present ONLY when nobody at all is
      live — that is the single state in which it is used, and loading it on the
      live paths would put a query on the hot path for nothing. */
  loopVideos?: LoopVideo[];
  /** Combined viewer total (all platforms) from the latest 60s snapshot while
      the streamer is live — lets the status poll keep the on-page count fresh. */
  viewers?: number | null;
  /** The streamer's LIVE YouTube broadcast id (v115), present only while live and only
      once stream-ingest has confirmed one — the player embeds by id when set
      and by channel otherwise (playerSource.youtubeLiveSrc). */
  ytVideoId?: string | null;
  /** Each platform's public live state (stream-api /stream/current `liveness`, cut again through
      PLATFORM_LIVENESS.publicSnapshot so nothing but state/since/scheduledStart is ever passed on).
      Present whenever stream-api answered; absent on a degraded load. `platforms` names only the
      platforms reported — a missing one means "keep what is shown", never offline. */
  liveness?: PublicSnapshot;
};

// Uncached, this would run a stream-api HTTP round-trip on EVERY call — plus the
// loop playlist query whenever nobody at all is live — and it
// sits on every hot path: /api/stream/status (polled every 30s by every
// client), /api/points/heartbeat (every 60s per signed-in viewer), and
// maybeEarnChatCoin on EVERY accepted chat message. At 50 viewers that is 200+
// round-trips/min from the web app to stream-api, and a stream-api hiccup
// would latency-couple every chat send. The heartbeat route relies on this
// cache.
//
// 5s: liveness gates coin earning, so staleness has a (small) money cost — at most
// 5s of beats either side of a transition. That still collapses ~200 calls/min to
// ~12 while keeping the window far under the 60s heartbeat interval.
//
// An upstream failure is NOT cached — and inside 60s it is not even SERVED: the
// loader's degraded answer is "nobody is live", and serving it would make one
// stream-api hiccup unmount every viewer's player and flip them to Radio for a
// poll. Past 60s (two client polls) a real outage reads as offline. Cost if
// wrong: at most one extra 60s coin heartbeat against a stale `live: true`.
async function loadStreamStatus(): Promise<{ data: StreamStatus; cacheable: boolean }> {
  try {
    const res = await streamApiFetch(`/stream/current`, {
      next: { revalidate: 0 },
    } as RequestInit);
    const cur = res.ok ? await res.json().catch(() => null) : null;

    // A failed/!ok upstream read is a blip, not an answer — serve the fallback
    // but don't remember it.
    if (!res.ok || cur === null) return { data: { live: false, community: null, communities: [] }, cacheable: false };

    // Spread, not a key holding undefined: a degraded answer stays exactly the shape it was.
    const lv = livenessOf(cur);
    const liveness = lv ? { liveness: lv } : {};
    if (cur?.live) {
      const total = cur?.viewers?.total;
      const ytVideoId = typeof cur?.ytVideoId === "string" && cur.ytVideoId ? cur.ytVideoId : null;
      return {
        data: { live: true, community: null, communities: [], viewers: typeof total === "number" ? total : null, ytVideoId, ...liveness },
        cacheable: true,
      };
    }

    // Nobody else's page is read here: the refresher keeps the community slot in memory. The loop
    // playlist plays only while nobody is live, so only that answer pays for its query (v77).
    const loadLoop = async () =>
      (await pool.query<LoopVideo>(`SELECT video_id, title FROM site.community_loop_videos ORDER BY priority ASC`)).rows;
    return { data: { live: false, ...liveness, ...(await communityAnswer(communitySnapshot(), loadLoop)) }, cacheable: true };
  } catch {
    // Threw (stream-api unreachable, DB down). Serve not-live, don't remember it.
    return { data: { live: false, community: null, communities: [] }, cacheable: false };
  }
}

const statusCache = createTtlCache<StreamStatus>({ ttlMs: 5_000, serveStaleForMs: 60_000, load: loadStreamStatus });

/** Was the answer getStreamStatus just gave a FRESH, remembered one? False
 *  after a degraded load (stream-api blip → "nobody is live", not cached) or a
 *  stale-while-error serve. The player wants the soft answer; a page that
 *  would otherwise print "Offline" as fact wants to know (Home, /api/home).
 *  Declared ABOVE getStreamStatus: four player tests anchor on this file
 *  ending with `statusCache.get();`. */
export const streamStatusFresh = (): boolean => statusCache.peek() !== null;

/** Live/community status, cached ~5s and shared across concurrent callers. */
export const getStreamStatus = (): Promise<StreamStatus> => statusCache.get();

