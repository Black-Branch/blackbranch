// Is a community streamer live on Twitch? The rotation's YouTube channels are read from their
// quota-free live page (communityLive.ts); a Twitch login is asked here, all of them in one Helix
// call with the site's app token. A failed read is NO answer (null) — never "nobody is live", which
// would end a featured streamer on one Helix blip (research §C6). No Twitch app keys = Twitch is not
// asked at all (undefined): the community slot then reads YouTube alone.
import { twitchAppToken, twitchClientId } from "./twitch.ts";

export type TwitchLive = { title: string; avatar: string | null };

// Deadline on the Helix reads: the community refresher waits on them.
const TWITCH_FETCH_TIMEOUT_MS = 5_000;
// One answer per minute for the same logins. Only an answer is remembered: a failure is retried on
// the next round.
const TWITCH_LIVE_CACHE_MS = 60_000;
let cache: { at: number; key: string; live: Map<string, TwitchLive> } | null = null;

type HelixStreams = { data?: { user_login?: string; title?: string; type?: string }[] };
type HelixUsers = { data?: { login?: string; profile_image_url?: string }[] };

/** Helix /streams and /users answers → lowercase login → its live stream, or null when /streams did
 *  not answer. Only a `live` stream counts; the avatar only from Twitch's own image host over https
 *  (a failed /users read costs the pictures, not the answer). Pure.
 *  @test-only twitchLive.test.ts feeds it Helix answers; twitchLiveLogins below is its runtime caller. */
export function liveFromHelix(streams: HelixStreams | null, users: HelixUsers | null): Map<string, TwitchLive> | null {
  if (!streams) return null;
  const avatars = new Map<string, string>();
  for (const u of users?.data ?? []) {
    if (!u.login || !u.profile_image_url) continue;
    try {
      const url = new URL(u.profile_image_url);
      if (url.protocol === "https:" && /(^|\.)jtvnw\.net$/.test(url.hostname)) avatars.set(u.login.toLowerCase(), url.href);
    } catch { /* not a URL: no avatar */ }
  }
  const live = new Map<string, TwitchLive>();
  for (const s of streams.data ?? []) {
    if (!s.user_login || s.type !== "live") continue;
    const login = s.user_login.toLowerCase();
    live.set(login, { title: s.title ?? "", avatar: avatars.get(login) ?? null });
  }
  return live;
}

/** The given logins that are live on Twitch now, keyed by lowercase login; null = the /streams read
 *  failed; undefined = not asked (no app token). */
export async function twitchLiveLogins(logins: readonly string[]): Promise<Map<string, TwitchLive> | null | undefined> {
  const wanted = [...new Set(logins.map((l) => l.toLowerCase()))].sort().slice(0, 100);
  if (wanted.length === 0) return new Map();
  const key = wanted.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TWITCH_LIVE_CACHE_MS) return cache.live;
  const token = await twitchAppToken();
  if (!token) return undefined;
  const q = wanted.map((l) => `user_login=${encodeURIComponent(l)}`).join("&");
  const uq = wanted.map((l) => `login=${encodeURIComponent(l)}`).join("&");
  const headers = { Authorization: `Bearer ${token}`, "Client-Id": twitchClientId() };
  const read = async <T,>(url: string): Promise<T | null> => {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(TWITCH_FETCH_TIMEOUT_MS), cache: "no-store" });
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const [streams, users] = await Promise.all([
    read<HelixStreams>(`https://api.twitch.tv/helix/streams?${q}`),
    read<HelixUsers>(`https://api.twitch.tv/helix/users?${uq}`),
  ]);
  const live = liveFromHelix(streams, users);
  if (live) cache = { at: Date.now(), key, live };
  return live;
}
