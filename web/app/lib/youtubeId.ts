// YouTube video-id parsing — one implementation, used by the OG/link-preview
// scraper and by the community loop-video playlist.
//
// This is the VIDEO id space. It is not interchangeable with the CHANNEL id
// space (`UC…`, 24 chars) that site.community_embeds.youtube_channel_id holds,
// and mixing the two is an easy mistake. Anything named `videoId` here is a
// watch id; channels are resolved separately in api/mod/embed/route.ts.

/**
 * The video id inside a YouTube URL, or null.
 *
 * Length is checked loosely (6–15) rather than pinned at 11: 11 is what YouTube
 * currently issues, but it has never been promised, and a hard check would fail
 * closed on the day it changes.
 */
export function youtubeVideoIdFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^www\./, "");
    let id: string | null = null;
    if (h === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0] || null;
    } else if (h === "youtube.com" || h === "m.youtube.com" || h === "music.youtube.com") {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
        if (m) id = m[1] ?? null;
      }
    }
    return id && /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Accepts what a mod would actually paste: a full URL, or a bare video id.
 *
 * A bare string is only taken as an id when it is EXACTLY id-shaped. Being
 * lenient here would turn a mistyped URL, a channel handle, or a whole sentence
 * into a "video id" that silently yields a dead embed in the rotation.
 */
export function parseYoutubeVideoId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{6,15}$/.test(s) && !s.includes(".")) return s;
  return youtubeVideoIdFromUrl(s.startsWith("http") ? s : `https://${s}`);
}
