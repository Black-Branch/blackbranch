// Which bucket a network request belongs to, for the device-health report.
//
// PRIVACY BY REDUCTION. A request URL can carry anything — a query token, a Matrix room id, a
// third-party path. The report never holds a URL at all: each request is reduced to ONE of these
// fixed category names on the device, and only the counts leave the browser.

import { matrixBaseHostname } from "../matrixConfig.ts";

export const CATEGORIES = [
  "emote_7tv", "emote_bttv", "emote_ffz", "emote_twitch", "avatar", "badges",
  "api", "matrix", "js", "css", "font", "media", "image_other", "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

const MEDIA = /\.(?:m3u8|m4s|ts)$/i;

/** The category for one Resource Timing entry. `origin` is the page's own origin. */
export function categorize(name: string, initiatorType: string, origin: string): Category {
  let u: URL;
  try {
    u = new URL(name, origin);
  } catch {
    return "other";
  }
  const host = u.hostname;
  const p = u.pathname;
  if (host === "cdn.7tv.app") return "emote_7tv";
  if (host === "cdn.betterttv.net") return "emote_bttv";
  if (host === "cdn.frankerfacez.com") return "emote_ffz";
  if (host === "static-cdn.jtvnw.net") {
    if (p.startsWith("/emoticons/")) return "emote_twitch";
    if (p.startsWith("/jtv_user_pictures/")) return "avatar";
  }
  if (host === "yt3.ggpht.com") return "avatar";
  if (host === matrixBaseHostname()) return "matrix";
  if (MEDIA.test(p)) return "media";
  if (u.origin === origin) {
    if (p === "/api/badges" || p.startsWith("/api/badges/image/")) return "badges";
    if (p.startsWith("/api/")) return "api";
    if (p.startsWith("/_next/static/")) {
      if (p.endsWith(".js")) return "js";
      if (p.endsWith(".css")) return "css";
      if (p.endsWith(".woff2")) return "font";
    }
  }
  return initiatorType === "img" ? "image_other" : "other";
}
