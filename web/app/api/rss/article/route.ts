import pool from "@/lib/db";
import { auth } from "@/auth";
import { safeFetch } from "@/app/lib/ssrf";
import { createArticleExtractor } from "@/app/lib/articleExtract";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { NextRequest } from "next/server";

// GET /api/rss/article?url=<feed item link> → { title, byline, html } | { error }
// Server-side readable-article extraction for the in-panel reader. The URL must be
// a link we already store in site.rss_items (so this isn't an open fetch proxy);
// it's then safeFetch'd (SSRF-guarded), run through Readability, and sanitized.
// Paywalled / JS-only pages yield little — the client falls back to the summary +
// an archive.is link.

// Extraction is the expensive part (jsdom + Readability on a small server), so gate the
// cache-MISS path only: 10 extractions/min per user (or per-IP bucket for
// signed-out readers — the feed is public), plus a small global concurrency cap
// so a burst of distinct URLs can't stack parses. Cache hits stay unmetered.
// The cap, the per-URL deadline and byte limit, and the sharing of one extraction
// between concurrent readers of the same URL live in articleExtract.ts.
const isExtractRateLimited = createSlidingWindowLimiter(60_000, 10);
const extractor = createArticleExtractor({ fetch: (url, init) => safeFetch(url, init) });

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? "";
  if (!url) return Response.json({ error: "missing url" }, { status: 400 });

  // Only extract links we actually serve in the feed.
  const known = await pool
    .query("SELECT 1 FROM site.rss_items WHERE link = $1 LIMIT 1", [url])
    .catch(() => ({ rowCount: 0 }));
  if (!known.rowCount) return Response.json({ error: "unknown url" }, { status: 400 });

  // Google News proxy links are JS-redirects (no server-resolvable target), so
  // extraction would only pull Google's stub. Bail early — the reader falls back to
  // the summary + "Open original" (which resolves the redirect in the browser).
  if (/(^|\.)news\.google\.com$/i.test(new URL(url).hostname)) {
    return Response.json({ error: "source_redirect" }, { status: 502 });
  }

  const hit = extractor.cached(url);
  if (hit) return Response.json(hit);

  // Cache miss → this request will run an extraction. Meter it.
  const session = await auth().catch(() => null);
  const rateKey = session?.user?.id ?? ipKey(req);
  if (isExtractRateLimited(rateKey)) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const running = extractor.extract(url);
  if (!running) return Response.json({ error: "busy" }, { status: 503 });

  const out = await running;
  return out.ok ? Response.json(out.data) : Response.json({ error: out.error }, { status: 502 });
}
