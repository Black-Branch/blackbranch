import { youtubeVideoIdFromUrl } from "@/app/lib/youtubeId";
import { NextRequest } from "next/server";
import { isPrivateUrl, safeFetch } from "@/app/lib/ssrf";
import { readJsonCapped } from "@/app/lib/boundedBody";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { tweetIdFromUrl } from "@/app/lib/tweetId";
import { tweetCardFromFx } from "@/app/lib/tweetCard";
import { authOrigin } from "@/app/lib/authOrigin";

// Made on first use, not at load: the origin is this install's, read when the server starts (a
// module evaluated during `next build` has none).
let ua = "";
const ogUserAgent = () => (ua ||= `Mozilla/5.0 (compatible; ${new URL(authOrigin()).host}/1.0; +${authOrigin()})`);

// Unauthenticated server-side URL fetcher (link previews in chat). Rate-limit
// per client IP so it can't be turned into an open scraping/SSRF-probe proxy —
// 30 previews/min covers a fast chat scroll with headroom.
const isRateLimited = createSlidingWindowLimiter(60_000, 30);

// YouTube serves a consent/bot wall to non-browser fetches, so plain OG
// scraping returns nothing. Pull the video id so we can use oEmbed (title) +
// the predictable thumbnail URL instead. Parser shared with the community
// loop-video playlist — see app/lib/youtubeId.ts.

function extractMeta(html: string, ...selectors: RegExp[]): string | null {
  for (const sel of selectors) {
    const m = html.match(sel);
    if (m?.[1]) return m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (isRateLimited(ipKey(req))) {
    return Response.json(null, { status: 429 });
  }
  const url = req.nextUrl.searchParams.get("url");
  if (!url || !/^https:\/\//.test(url) || isPrivateUrl(url)) {
    return Response.json(null, { status: 400 });
  }

  const yt = youtubeVideoIdFromUrl(url);
  if (yt) {
    const image = `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
    try {
      const oe = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {
        signal: AbortSignal.timeout(6000),
      });
      const j = oe.ok ? (await readJsonCapped(oe, 64 * 1024)) as { title?: string; author_name?: string } | null : null;
      if (j) {
        return Response.json({
          title: j.title ?? null,
          description: j.author_name ? `by ${j.author_name}` : null,
          image,
          siteName: "YouTube",
          url,
        });
      }
    } catch { /* fall through to thumbnail-only */ }
    return Response.json({ title: null, description: null, image, siteName: "YouTube", url });
  }

  // x.com hands a server-side fetcher a JS shell with no OG tags, so a tweet
  // link goes to FxTwitter's JSON API by id — the id is digits or nothing
  // (tweetIdFromUrl), so this URL is never built from user input, and there is
  // no fall-through to the generic scrape: a missing tweet is no card.
  const tweetId = tweetIdFromUrl(url);
  if (tweetId) {
    try {
      const fx = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
        headers: { "User-Agent": ogUserAgent(), Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!fx.ok) return Response.json(null);
      // A status with its quote, media and poll is tens of KB.
      const json = await readJsonCapped(fx, 512 * 1024);
      return Response.json(json === null ? null : tweetCardFromFx(json, url));
    } catch {
      return Response.json(null);
    }
  }

  try {
    const res = await safeFetch(url, {
      headers: {
        "User-Agent": ogUserAgent(),
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return Response.json(null);

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return Response.json(null);

    // Only read the first 64 KB — OG tags are always in <head>
    const reader = res.body?.getReader();
    if (!reader) return Response.json(null);
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 65536) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
    reader.cancel().catch(() => {});
    const html = new TextDecoder().decode(
      chunks.reduce((acc, c) => { const r = new Uint8Array(acc.length + c.length); r.set(acc); r.set(c, acc.length); return r; }, new Uint8Array(0))
    );

    const title = extractMeta(html,
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
      /<title[^>]*>([^<]+)<\/title>/i,
    );
    const description = extractMeta(html,
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
    );
    const image = extractMeta(html,
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    );
    const siteName = extractMeta(html,
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i,
    );

    if (!title && !image) return Response.json(null);
    return Response.json({ title, description, image, siteName, url });
  } catch {
    return Response.json(null);
  }
}
