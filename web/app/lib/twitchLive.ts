// Is a featured streamer live on Twitch? The rotation's YouTube channels are checked by their
// quota-free live page (streamStatus.ts); a Twitch login is checked here, all of them in one Helix
// call with the site's app token. No Twitch app keys = no answer, so the entry reads as not live.
import { twitchAppToken, twitchClientId } from "./twitch.ts";

export type TwitchLive = { title: string; avatar: string | null };

// Deadline on the Helix reads: this sits under the stream status every viewer polls.
const TWITCH_FETCH_TIMEOUT_MS = 5_000;
// One answer per minute for the same logins. A failed read is remembered for the same minute: the
// status loader must not retry Helix on every 5 s cache miss.
const TWITCH_LIVE_CACHE_MS = 60_000;
let cache: { at: number; key: string; live: Map<string, TwitchLive> } | null = null;

type HelixStreams = { data?: { user_login?: string; title?: string; type?: string }[] };
type HelixUsers = { data?: { login?: string; profile_image_url?: string }[] };

/** Helix /streams and /users answers → lowercase login → its live stream. Only a `live` stream
 *  counts; the avatar only from Twitch's own image host over https. Pure.
 *  @test-only twitchLive.test.ts feeds it Helix answers; twitchLiveLogins below is its runtime caller. */
export function liveFromHelix(streams: HelixStreams | null, users: HelixUsers | null): Map<string, TwitchLive> {
  const avatars = new Map<string, string>();
  for (const u of users?.data ?? []) {
    if (!u.login || !u.profile_image_url) continue;
    try {
      const url = new URL(u.profile_image_url);
      if (url.protocol === "https:" && /(^|\.)jtvnw\.net$/.test(url.hostname)) avatars.set(u.login.toLowerCase(), url.href);
    } catch { /* not a URL: no avatar */ }
  }
  const live = new Map<string, TwitchLive>();
  for (const s of streams?.data ?? []) {
    if (!s.user_login || s.type !== "live") continue;
    const login = s.user_login.toLowerCase();
    live.set(login, { title: s.title ?? "", avatar: avatars.get(login) ?? null });
  }
  return live;
}

/** The given logins that are live on Twitch now, keyed by lowercase login. */
export async function twitchLiveLogins(logins: readonly string[]): Promise<Map<string, TwitchLive>> {
  const wanted = [...new Set(logins.map((l) => l.toLowerCase()))].sort().slice(0, 100);
  if (wanted.length === 0) return new Map();
  const key = wanted.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TWITCH_LIVE_CACHE_MS) return cache.live;
  let live = new Map<string, TwitchLive>();
  const token = await twitchAppToken();
  if (token) {
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
    live = liveFromHelix(streams, users);
  }
  cache = { at: Date.now(), key, live };
  return live;
}
