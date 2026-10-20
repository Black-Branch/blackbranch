// Tweet-id parsing for the link-preview route. x.com serves a JS shell with no
// OG tags to a server-side fetcher, so a tweet link is resolved through
// FxTwitter's JSON API instead — by id, which is the only thing this returns.

const TWEET_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "fxtwitter.com", "fixupx.com", "vxtwitter.com"]);

/** The status id inside a tweet URL (x/twitter and the fix-up mirrors), or null.
 *  Accepts `/<user>/status/<id>`, `/i/status/<id>` and `/status/<id>`; the id is
 *  1–25 digits (snowflakes are 19 today; the cap only rejects nonsense). */
export function tweetIdFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWEET_HOSTS.has(h)) return null;
    const m = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/)?status\/(\d{1,25})(?:\/|$)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
