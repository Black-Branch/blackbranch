// The community slot: which community streamers are live now, read in the BACKGROUND
// (startCommunityRefresher, from instrumentation.ts) and served from memory (communitySnapshot).
// No request ever waits on YouTube or Twitch: the status loader sits under every viewer's poll,
// the chat send and the coin heartbeat.
//
// The rules (per-platform liveness, Task 9; ADR 0134):
// - Every YouTube page is read through the ONE classifier (youtubeLive.generated.mjs). A scheduled
//   page is never live: another channel's scheduled stream is never listed (E5); the install's own
//   (`platform.youtube.channelId`) is, with its countdown (E4).
// - A failed or "can't tell" read keeps the last answer for COMMUNITY_KEEP_MS, then reads unknown —
//   never "nobody live".
// - The featured streamer stays while they are live or can't be told; a higher priority going live
//   does not take the slot (E9). Everyone live is listed, and the viewer chooses (communityTarget).
import pool from "@/lib/db";
import { instanceString } from "./instanceConfigServer.ts";
import { decodeHtmlEntities } from "@/app/lib/htmlEntities";
import { twitchLiveLogins, type TwitchLive } from "./twitchLive.ts";
import { YOUTUBE_LIVE } from "./youtubeLive.generated.mjs";
import type { YtClass } from "./youtubeLive.generated.mjs";
import type { CommunityStatus } from "./streamStatus.ts";
import type { LoopVideo } from "./streamView";

const COMMUNITY_REFRESH_MS = 180_000;
const COMMUNITY_KEEP_MS = 10 * 60_000;
// A featured streamer whose every asked platform has read "can't tell" this long is released: the slot
// moves to someone live, or empties (lead's ruling on Task 9's review, 2026-10-25).
const COMMUNITY_HOLD_UNKNOWN_MS = 30 * 60_000;
// Deadline on each page read and avatar lookup: a hung read must not hold the next round.
const YT_FETCH_TIMEOUT_MS = 7_000;
// Avatars rarely change; a failed lookup is retried after 5 min, not tomorrow.
const AVATAR_CACHE_MS = 24 * 60 * 60 * 1000;
const AVATAR_FAIL_CACHE_MS = 5 * 60 * 1000;

export type Row = {
  display_name: string;
  youtube_channel_id: string | null;
  twitch_login: string | null;
  ingest_youtube: boolean;
  ingest_twitch: boolean;
  priority: number;
};
type YtPart = YtClass & { at: number; title: string; avatar: string | null };
/** `seenLive`: this reading (or the answer it was kept from) said live — only then is the channel
 *  something to play while Twitch can't be told. */
type TwitchPart = { state: "live" | "offline" | "unknown"; title: string; avatar: string | null; at: number; seenLive: boolean };
/** One row's latest reading per platform. `null` = not asked (no channel, no Twitch keys), or a failed
 *  read with nothing to keep. `unknownSince`: since when every asked platform has read unknown. */
export type RowCheck = { yt: YtPart | null; twitch: TwitchPart | null; unknownSince?: number | null };
export type CommunityPick = { featured: CommunityStatus | null; live: CommunityStatus[] };

const rowKey = (row: Pick<Row, "youtube_channel_id" | "twitch_login">): string =>
  row.youtube_channel_id ?? `tw:${row.twitch_login ?? ""}`;

const answered = (p: { state: string } | null | undefined): boolean => !!p && p.state !== "unknown";

function mergePart<P extends { state: string; at: number }>(prev: P | null | undefined, next: P | null, now: number): P | null {
  if (answered(next)) return next;
  if (prev && answered(prev) && now - prev.at <= COMMUNITY_KEEP_MS) return prev;
  // Past the window: "can't tell", keeping what it was playing for a featured streamer who stays.
  if (prev) return { ...prev, state: "unknown" };
  return next;
}

/** A failed or unknown part keeps the previous answer for COMMUNITY_KEEP_MS (counted from that
 *  answer), then reads unknown; an answer replaces it at once.
 *  @test-only exported for communityLive.test.ts; the refresher below is its runtime caller. */
export function mergeCheck(prev: RowCheck | undefined, next: RowCheck, now: number): RowCheck {
  const yt = mergePart(prev?.yt, next.yt, now);
  const twitch = mergePart(prev?.twitch, next.twitch, now);
  const asked = [partState(yt, now), partState(twitch, now)].filter((s) => s !== null);
  const allUnknown = asked.length > 0 && asked.every((s) => s === "unknown");
  return { yt, twitch, unknownSince: allUnknown ? (prev?.unknownSince ?? now) : null };
}

/** A part's state as of `now`: an answer older than the keep window is "can't tell". */
function partState(p: { state: string; at: number } | null | undefined, now: number): string | null {
  if (!p) return null;
  return answered(p) && now - p.at > COMMUNITY_KEEP_MS ? "unknown" : p.state;
}

type RowState = "live" | "scheduled" | "unknown" | "offline" | "none";

/** Live when an asked platform says live; offline when one answered not-live and none says live;
 *  unknown only when EVERY asked platform can't be told (one platform's blip never holds a streamer
 *  the other platform said has ended). */
function rowState(c: RowCheck | undefined, own: boolean, now: number): RowState {
  const yt = partState(c?.yt, now);
  const tw = partState(c?.twitch, now);
  if (yt === "live" || tw === "live") return "live";
  if (own && yt === "upcoming") return "scheduled";
  const asked = [yt, tw].filter((s) => s !== null);
  if (asked.length === 0) return "none";
  return asked.every((s) => s === "unknown") ? "unknown" : "offline";
}

function entryOf(row: Row, c: RowCheck | undefined, own: boolean, now: number, state: RowState): CommunityStatus | null {
  const key = rowKey(row);
  const yt = c?.yt ?? null;
  const tw = c?.twitch ?? null;
  const ytS = partState(yt, now);
  const twS = partState(tw, now);
  // A part carries a video id only from a live answer (or our own countdown) — see readYouTube.
  const ytVideo = row.youtube_channel_id && yt?.videoId ? yt.videoId : null;
  const fromYouTube = (y: YtPart, videoId: string, scheduled: boolean): CommunityStatus => {
    const sources: CommunityStatus["sources"] = [];
    if (row.ingest_youtube) sources.push({ platform: "youtube", id: videoId });
    if (row.ingest_twitch && row.twitch_login) sources.push({ platform: "twitch", id: row.twitch_login });
    // The playing source is always offered, even with its flag off: never a featured entry with no player.
    if (sources.length === 0) sources.push({ platform: "youtube", id: videoId });
    return {
      key, display_name: row.display_name, youtube_channel_id: row.youtube_channel_id, video_id: videoId,
      stream_title: y.title, avatar_url: y.avatar, twitch_login: row.twitch_login ?? null, sources,
      scheduled: scheduled ? { startsAt: y.scheduledStart } : null,
    };
  };
  const fromTwitch = (t: TwitchPart, login: string): CommunityStatus => ({
    key, display_name: row.display_name, youtube_channel_id: row.youtube_channel_id, video_id: null,
    stream_title: t.title, avatar_url: t.avatar, twitch_login: login, sources: [{ platform: "twitch", id: login }], scheduled: null,
  });
  const login = row.twitch_login;
  if (yt && ytVideo && ytS === "live") return fromYouTube(yt, ytVideo, false);
  if (tw && login && twS === "live") return fromTwitch(tw, login);
  if (yt && ytVideo && own && ytS === "upcoming") return fromYouTube(yt, ytVideo, true);
  // Held while can't be told: only from a platform whose own last answer was live (a YouTube part
  // carries a video id only then; a Twitch part says so in seenLive).
  if (state === "unknown") {
    if (yt && ytVideo && ytS === "unknown") return fromYouTube(yt, ytVideo, false);
    if (tw && login && twS === "unknown" && tw.seenLive) return fromTwitch(tw, login);
  }
  return null;
}

/** Who is featured and who is listed. Listed: live now, or the install's own countdown. Featured:
 *  the previous featured while it is live or can't be told (E9) — the latter for at most
 *  COMMUNITY_HOLD_UNKNOWN_MS — else the first listed by priority.
 *  `live` is the featured first, then priority order.
 *  @test-only exported for communityLive.test.ts; the refresher below is its runtime caller. */
export function pickCommunity({ rows, checks, prevFeaturedKey, ownChannelId, now }: {
  rows: readonly Row[];
  checks: ReadonlyMap<string, RowCheck>;
  prevFeaturedKey: string | null;
  ownChannelId: string | null;
  now: number;
}): CommunityPick {
  const seen = [...rows].sort((a, b) => a.priority - b.priority).map((row) => {
    const key = rowKey(row);
    const c = checks.get(key);
    const own = !!ownChannelId && row.youtube_channel_id === ownChannelId;
    const state = rowState(c, own, now);
    const heldTooLong = state === "unknown" && c?.unknownSince != null && now - c.unknownSince >= COMMUNITY_HOLD_UNKNOWN_MS;
    return { key, state, heldTooLong, entry: entryOf(row, c, own, now, state) };
  });
  const listed = seen.filter((s) => (s.state === "live" || s.state === "scheduled") && s.entry);
  const prev = prevFeaturedKey ? seen.find((s) => s.key === prevFeaturedKey) : undefined;
  const holds = prev && prev.entry && (prev.state === "live" || (prev.state === "unknown" && !prev.heldTooLong));
  const featured = holds ? prev : (listed[0] ?? null);
  const live = featured ? [featured, ...listed.filter((s) => s !== featured)] : [];
  return { featured: featured?.entry ?? null, live: live.map((s) => s.entry!) };
}

/** The status loader's offline answer: the community entries, or — nobody listed — the loop
 *  playlist, loaded only then (migrate-v77). */
export async function communityAnswer(pick: CommunityPick, loadLoop: () => Promise<LoopVideo[]>): Promise<
  { community: CommunityStatus | null; communities: CommunityStatus[]; loopVideos?: LoopVideo[] }
> {
  if (pick.featured) return { community: pick.featured, communities: pick.live };
  return { community: null, communities: [], loopVideos: await loadLoop() };
}

/** The channel's avatar from a live watch page's own data (`videoOwnerRenderer`'s thumbnail) —
 *  quota-free, so a featured streamer shows a face on an install with no YouTube API key.
 *  Only a YouTube image host over https; anything else is null. Pure.
 *  @test-only exported for communityLive.test.ts; readYouTube in this file is its runtime caller. */
export function avatarFromLivePage(html: string): string | null {
  const m = /"videoOwnerRenderer":\{"thumbnail":\{"thumbnails":\[\{"url":"([^"]+)"/.exec(html);
  if (!m?.[1]) return null;
  try {
    const u = new URL(m[1].replace(/\\u0026/g, "&"));
    if (u.protocol !== "https:" || !/(^|\.)(ggpht\.com|googleusercontent\.com)$/.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

const avatarCache = new Map<string, { url: string | null; ts: number; ttlMs: number }>();

/** A channel's avatar from the YouTube Data API (1 unit, cached a day). */
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

type RefresherDeps = {
  loadRows: () => Promise<Row[]>;
  /** The channel's /live page, or null when it could not be read. */
  readPage: (channelId: string) => Promise<string | null>;
  /** Live logins; null = asked and failed; undefined = not asked (no Twitch app keys). */
  twitchLive: (logins: string[]) => Promise<Map<string, TwitchLive> | null | undefined>;
  /** The Data API avatar, or null (no key, no answer). */
  avatar: (channelId: string) => Promise<string | null>;
  ownChannelId: () => string | null;
  now: () => number;
};

/** One channel's reading. A video id, title and avatar are kept only for a live answer (or our own
 *  countdown): a candidate, a foreign recommendation or someone's schedule is never something to play. */
async function readYouTube(deps: RefresherDeps, channelId: string, own: boolean, at: number): Promise<YtPart | null> {
  const html = await deps.readPage(channelId);
  if (html === null) return null;
  const cls = YOUTUBE_LIVE.classifyLivePage(html, channelId);
  const playable = cls.state === "live" || (own && cls.state === "upcoming");
  if (!playable) return { ...cls, videoId: "", at, title: "", avatar: null };
  const m = /<meta name="title" content="([^"]*)"/.exec(html) ?? /<title>([^<]*)<\/title>/.exec(html);
  const title = decodeHtmlEntities(m?.[1] ?? "").replace(/ - YouTube$/, "");
  return { ...cls, at, title, avatar: ((await deps.avatar(channelId)) ?? avatarFromLivePage(html)) };
}

/** A refresher over its own memory: `refresh()` reads every row once (single-flight — a call while
 *  one runs joins it), `snapshot()` only reads memory.
 *  @test-only exported for communityLive.test.ts (fake reads, restart = a new instance); the
 *  module's own refresher below is its runtime caller. */
export function createCommunityRefresher(deps: RefresherDeps) {
  let checks = new Map<string, RowCheck>();
  let featuredKey: string | null = null;
  let pick: CommunityPick = { featured: null, live: [] };
  let running: Promise<void> | null = null;
  let failing = false;

  async function once(): Promise<void> {
    let rows: Row[];
    try {
      rows = await deps.loadRows();
    } catch (e) {
      if (!failing) console.warn(`[community] could not read the rotation: ${e instanceof Error ? e.message : String(e)} — keeping what is shown`);
      failing = true;
      return;
    }
    failing = false;
    const own = deps.ownChannelId();
    const at = deps.now();
    const [yts, onTwitch] = await Promise.all([
      Promise.all(rows.map(async (row) =>
        row.youtube_channel_id ? readYouTube(deps, row.youtube_channel_id, row.youtube_channel_id === own, at) : null)),
      deps.twitchLive(rows.flatMap((r) => (r.twitch_login ? [r.twitch_login] : []))).catch(() => null),
    ]);
    const now = deps.now();
    const next = new Map<string, RowCheck>();
    rows.forEach((row, i) => {
      const login = row.twitch_login;
      const t = login ? onTwitch?.get(login.toLowerCase()) : undefined;
      // undefined = not asked (no Twitch app keys): no part at all, so it neither holds nor votes.
      const askTwitch = !!login && onTwitch !== undefined;
      const twitch: TwitchPart | null = !askTwitch ? null
        : !onTwitch ? { state: "unknown", title: "", avatar: null, at, seenLive: false }
        : t ? { state: "live", title: t.title, avatar: t.avatar, at, seenLive: true }
        : { state: "offline", title: "", avatar: null, at, seenLive: false };
      const key = rowKey(row);
      const before = checks.get(key);
      // A platform the row no longer carries (or no longer asks) has nothing to keep.
      const prev = before && { ...before, yt: row.youtube_channel_id ? before.yt : null, twitch: askTwitch ? before.twitch : null };
      next.set(key, mergeCheck(prev, { yt: yts[i] ?? null, twitch }, now));
    });
    checks = next;
    const p = pickCommunity({ rows, checks, prevFeaturedKey: featuredKey, ownChannelId: own, now });
    const key = p.featured?.key ?? null;
    if (key !== featuredKey) console.log(`[community] featured: ${p.featured?.display_name ?? "nobody"} (${p.live.length} listed)`);
    featuredKey = key;
    pick = p;
  }

  return {
    refresh(): Promise<void> {
      running ??= once().catch((e) => {
        console.warn(`[community] refresh failed: ${e instanceof Error ? e.message : String(e)}`);
      }).finally(() => { running = null; });
      return running;
    },
    snapshot: (): CommunityPick => pick,
  };
}

// ONE refresher per process, on globalThis: Next bundles this module into more than one chunk, and
// the timer runs in instrumentation.ts's copy while the status loader reads from its own — a
// module-level instance would leave every request reading an empty slot.
type Slot = { refresher: ReturnType<typeof createCommunityRefresher>; started: boolean };
const SLOT_KEY = Symbol.for("bb.communityLive");
const slots = globalThis as unknown as Record<symbol, Slot | undefined>;
const slot: Slot = (slots[SLOT_KEY] ??= { started: false, refresher: createCommunityRefresher({
  loadRows: async () => (await pool.query<Row>(
    `SELECT COALESCE(display_name, channel_name) AS display_name, youtube_channel_id, twitch_login, ingest_youtube, ingest_twitch, priority
       FROM site.community_embeds
      WHERE youtube_channel_id IS NOT NULL OR twitch_login IS NOT NULL
      ORDER BY priority ASC`,
  )).rows,
  readPage: async (channelId) => {
    try {
      // The quota-free /live page (search.list cost 100 units of a 10k/day quota per call).
      const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
        headers: {
          // YouTube serves a stripped page to unknown agents
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(YT_FETCH_TIMEOUT_MS),
      });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  },
  twitchLive: twitchLiveLogins,
  avatar: async (channelId) => {
    const apiKey = instanceString("youtube.apiKey");
    return apiKey ? getChannelAvatar(channelId, apiKey) : null;
  },
  ownChannelId: () => instanceString("platform.youtube.channelId"),
  now: Date.now,
}) });
const community = slot.refresher;

/** From boot, every COMMUNITY_REFRESH_MS: read the rotation. Called once by instrumentation.ts. */
export function startCommunityRefresher(): void {
  if (slot.started) return;
  slot.started = true;
  void community.refresh();
  setInterval(() => { void community.refresh(); }, COMMUNITY_REFRESH_MS).unref();
}

/** What the last refresh found. Never fetches. */
export function communitySnapshot(): CommunityPick {
  return community.snapshot();
}
