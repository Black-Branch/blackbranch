import type { LoopVideo } from "./streamView";
// Single source of truth for "who is featured right now" + streamer-live takeover.
// Used by GET /api/stream/status (frontend video embed + the stream-ingest relay
// controller) AND by /api/chat/send (to route outbound chat to whoever is
// currently featured). Selection: streamer live → takeover (community:null); else
// the first YouTube-live community embed in priority order.

import pool from "@/lib/db";
import { createTtlCache } from "./ttlCache";
import { streamApiFetch } from "@/app/lib/streamApi";
import { instanceString } from "./instanceConfigServer.ts";

export type CommunityStatus = {
  display_name: string;
  youtube_channel_id: string;
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
      needs. Always includes at least the live YouTube source. */
  sources: { platform: "youtube" | "twitch"; id: string }[];
};

export type StreamStatus = {
  live: boolean;
  community: CommunityStatus | null;
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
};

// Live check cache: channelId → result + timestamp. A GOOD answer lives 5 min
// (the check is a quota-free page scrape, so it can afford to be snappy). A
// FAILED scrape (timeout, non-2xx, network) is remembered too, but only for
// 45s: not remembering it at all meant one hung channel page was re-fetched on
// every 5s status miss — and, the loader being single-flight, every caller
// waited on it. Each entry carries its own TTL so one lookup serves both.
const ytCache = new Map<string, { live: boolean; title: string; videoId: string | null; ts: number; ttlMs: number }>();
const YT_CACHE_MS = 5 * 60 * 1000;
const YT_FAIL_CACHE_MS = 45 * 1000;
// Deadline on the scrape and the avatar lookup. This loader sits under
// /api/stream/status, /api/chat/send and the coin heartbeat; one fetch with no
// deadline would stall all three.
const YT_FETCH_TIMEOUT_MS = 7_000;

// Avatar cache: channelId → url + timestamp. 24h for a real answer (avatars
// rarely change); 5 min for a failed lookup — remembered for a full day, a transient
// API error would hide a streamer's avatar until tomorrow.
const avatarCache = new Map<string, { url: string | null; ts: number; ttlMs: number }>();
const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
const AVATAR_FAIL_CACHE_MS = 5 * 60 * 1000;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Live check via the channel's public /live page — zero API quota. The old
// search.list call cost 100 units each against a 100-queries/DAY limit, so
// the rotation died ~8h after the key was provisioned ("worked once").
async function checkYouTubeLive(channelId: string) {
  const cached = ytCache.get(channelId);
  if (cached && Date.now() - cached.ts < cached.ttlMs) return cached;

  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: {
        // YouTube serves a stripped page to unknown agents
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(YT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`YouTube live page ${res.status}`);
    const html = await res.text();

    // Offline channels' /live redirects to the channel home, which carries no
    // player metadata — verified live page has "isLive":true (twice), offline
    // has zero occurrences.
    const live = html.includes('"isLive":true');
    let title = "";
    let videoId: string | null = null;
    if (live) {
      const m =
        /<meta name="title" content="([^"]*)"/.exec(html) ??
        /<title>([^<]*)<\/title>/.exec(html);
      title = decodeEntities(m?.[1] ?? "").replace(/ - YouTube$/, "");
      // The canonical link IS the live stream — "videoId" occurrences also
      // cover related videos, so they can't be used directly
      videoId =
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/.exec(html)?.[1] ??
        null;
    }

    const r = { live, title, videoId, ts: Date.now(), ttlMs: YT_CACHE_MS };
    ytCache.set(channelId, r);
    return r;
  } catch {
    // Remembered briefly (see YT_FAIL_CACHE_MS) — the next scan after that retries.
    const r = { live: false, title: "", videoId: null, ts: Date.now(), ttlMs: YT_FAIL_CACHE_MS };
    ytCache.set(channelId, r);
    return r;
  }
}

export async function getChannelAvatar(channelId: string, apiKey: string): Promise<string | null> {
  const cached = avatarCache.get(channelId);
  if (cached && Date.now() - cached.ts < cached.ttlMs) return cached.url;

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${apiKey}`,
      { signal: AbortSignal.timeout(YT_FETCH_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`YouTube channels ${res.status}`);
    const data = await res.json();
    const thumbnails = data.items?.[0]?.snippet?.thumbnails;
    const url = thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
    avatarCache.set(channelId, { url, ts: Date.now(), ttlMs: AVATAR_CACHE_MS });
    return url;
  } catch {
    avatarCache.set(channelId, { url: null, ts: Date.now(), ttlMs: AVATAR_FAIL_CACHE_MS });
    return null;
  }
}

// Uncached, this would run a stream-api HTTP round-trip on EVERY call — plus a
// full site.community_embeds scan whenever the streamer is offline — and it
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
    if (!res.ok || cur === null) return { data: { live: false, community: null }, cacheable: false };

    if (cur?.live) {
      const total = cur?.viewers?.total;
      const ytVideoId = typeof cur?.ytVideoId === "string" && cur.ytVideoId ? cur.ytVideoId : null;
      return {
        data: { live: true, community: null, viewers: typeof total === "number" ? total : null, ytVideoId },
        cacheable: true,
      };
    }

    // The live check is quota-free; the API key is only needed for avatars
    const apiKey = instanceString("youtube.apiKey");

    const { rows } = await pool.query<{
      display_name: string;
      youtube_channel_id: string;
      twitch_login: string | null;
      ingest_enabled: boolean;
      ingest_twitch: boolean;
      ingest_youtube: boolean;
    }>(
      `SELECT display_name, youtube_channel_id, twitch_login,
              ingest_enabled, ingest_twitch, ingest_youtube
       FROM site.community_embeds
       WHERE youtube_channel_id IS NOT NULL
       ORDER BY priority ASC`
    );

    // Every channel is checked at once: the scan's latency is the slowest
    // scrape, not the sum of them all. Priority order still decides — the first
    // LIVE row in the list wins.
    const checks = await Promise.all(rows.map((row) => checkYouTubeLive(row.youtube_channel_id)));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const check = checks[i]!;
      if (check.live) {
        const avatar_url = apiKey
          ? await getChannelAvatar(row.youtube_channel_id, apiKey)
          : null;
        // Video sources: per-platform flag + handle.
        // The handles below are ungated now: they exist so an outbound cross-post
        // can reach the featured streamer's channel, which has nothing to do with
        // whether their video source is switchable.
        const sources: { platform: "youtube" | "twitch"; id: string }[] = [];
        if (row.ingest_youtube) sources.push({ platform: "youtube", id: check.videoId ?? row.youtube_channel_id });
        if (row.ingest_twitch && row.twitch_login) sources.push({ platform: "twitch", id: row.twitch_login });
        // Always offer the live YouTube source even if its flag was off, so the
        // featured stream is never left with no playable source.
        if (sources.length === 0) sources.push({ platform: "youtube", id: check.videoId ?? row.youtube_channel_id });
        return { cacheable: true, data: {
          live: false,
          community: {
            display_name:       row.display_name,
            youtube_channel_id: row.youtube_channel_id,
            video_id:           check.videoId,
            stream_title:       check.title,
            avatar_url,
            twitch_login:       row.twitch_login ?? null,
            sources,
          },
        } };
      }
    }

    // Nobody live anywhere. This is the ONLY state the loop playlist plays in, so
    // it is also the only state we pay for the query in — see migrate-v77.sql.
    const { rows: loop } = await pool.query<LoopVideo>(
      `SELECT video_id, title FROM site.community_loop_videos ORDER BY priority ASC`
    );
    return { data: { live: false, community: null, loopVideos: loop }, cacheable: true };
  } catch {
    // Threw (stream-api unreachable, DB down). Serve not-live, don't remember it.
    return { data: { live: false, community: null }, cacheable: false };
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

