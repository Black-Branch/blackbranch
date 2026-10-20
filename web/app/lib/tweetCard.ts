// FxTwitter (api.fxtwitter.com) JSON → the post card LinkPreview renders.
// Shape verified against real responses: `tweet.{text, url, likes,
// retweets, replies, author.{name, screen_name, avatar_url},
// media.{photos[], videos[]}}`; a photo is `{url, width, height}`, a video is
// `{url, thumbnail_url, width, height}`.

export type TweetCard = {
  kind: "post";
  title: string;
  description: string;
  image: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  avatar: string | null;
  stats: string;
  siteName: "X";
  url: string;
};

type FxMedia = { url?: string; thumbnail_url?: string; width?: number; height?: number };
type FxResponse = {
  code?: number;
  tweet?: {
    text?: string;
    url?: string;
    likes?: number;
    retweets?: number;
    replies?: number;
    author?: { name?: string; screen_name?: string; avatar_url?: string };
    media?: { photos?: FxMedia[]; videos?: FxMedia[] };
  };
};

/** 999 → "999", 1 000 → "1.0K", 4 029 152 → "4.0M"; anything unusable → "0". */
function compactCount(n: unknown): string {
  const v = typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}K`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

/** The card, or null when the response is not a usable tweet (the caller then
 *  shows nothing — never falls back to scraping x.com, which has no OG tags). */
export function tweetCardFromFx(json: unknown, fallbackUrl: string): TweetCard | null {
  if (!json || typeof json !== "object") return null;
  const r = json as FxResponse;
  const t = r.tweet;
  if (r.code !== 200 || !t || typeof t !== "object" || !t.author) return null;
  const screen = typeof t.author.screen_name === "string" ? t.author.screen_name : "";
  if (!screen) return null;
  const name = typeof t.author.name === "string" ? t.author.name.trim() : "";
  const photo = t.media?.photos?.[0];
  const video = t.media?.videos?.[0];
  // dims must come from whichever media actually supplied `image` — a photo
  // entry with no `url` must fall through to the video's thumbnail AND the
  // video's own width/height, never the (url-less) photo's dimensions.
  let image: string | null = null;
  let dims: FxMedia | undefined;
  if (photo?.url) { image = photo.url; dims = photo; }
  else if (video?.thumbnail_url) { image = video.thumbnail_url; dims = video; }
  return {
    kind: "post",
    title: name ? `${name} (@${screen})` : `@${screen}`,
    description: typeof t.text === "string" ? t.text.trim() : "",
    image,
    imageWidth: image && typeof dims?.width === "number" ? dims.width : null,
    imageHeight: image && typeof dims?.height === "number" ? dims.height : null,
    avatar: typeof t.author.avatar_url === "string" ? t.author.avatar_url : null,
    stats: `💬 ${compactCount(t.replies)} · 🔁 ${compactCount(t.retweets)} · ❤️ ${compactCount(t.likes)}`,
    siteName: "X",
    url: typeof t.url === "string" && /^https:\/\//.test(t.url) ? t.url : fallbackUrl,
  };
}
