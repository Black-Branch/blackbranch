import { YT_EMBED_PARAMS } from "./playerSource.ts";

export type Platform = "sp" | "yt" | "tw";

export type CommunitySource = { platform: "youtube" | "twitch"; id: string };

/** One entry of the community fallback playlist (migrate-v77) — what the
 *  community player loops when nobody at all is live. */
export type LoopVideo = { video_id: string; title: string | null };

// The embed URL that loops this list lives in ./loopPlaylist — kept in its own
// dependency-free module so `node --test` can load it directly. (This file used
// to carry an extensionless ./platformColors import that Node's ESM loader could
// not resolve; that import is gone, but loopPlaylist's zero-import rule stays —
// it is the property the tests rely on, not a workaround for one old import.)

export type CommunityStatus = {
  display_name: string;
  youtube_channel_id: string | null;
  video_id: string | null;
  stream_title: string;
  avatar_url: string | null;
  /** The entry's Twitch login — the channel to visit when it has no YouTube one. */
  twitch_login?: string | null;
  sources?: CommunitySource[];
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  sp: "Streamplace",
  yt: "YouTube",
  tw: "Twitch",
};

// Build the embed URL for a featured-streamer video source. `embedHost` is the
// live hostname Twitch validates `parent` against. (There is no Kick player;
// the slug still routes outbound cross-posts, see streamStatus.ts.)
export function communitySrc(s: CommunitySource, embedHost: string): string {
  if (s.platform === "twitch")
    return `https://player.twitch.tv/?channel=${s.id}&parent=${embedHost}&autoplay=true&muted=true`;
  // YouTube: a UC… channel id uses the live_stream endpoint, otherwise it's a video id
  return s.id.startsWith("UC")
    ? `https://www.youtube.com/embed/live_stream?channel=${s.id}&mute=1&${YT_EMBED_PARAMS}`
    : `https://www.youtube.com/embed/${s.id}?mute=1&${YT_EMBED_PARAMS}`;
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0] ?? "").join("").toUpperCase().slice(0, 2) || "?";
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

