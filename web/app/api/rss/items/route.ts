import { kickRefresh, listItems } from "@/app/lib/rssServer";
import { NextRequest } from "next/server";

// GET /api/rss/items?limit=50&q=<text> → { items: RssItem[] }
// Public read (viewers consume the feed). Poll-on-read: kick a best-effort,
// non-blocking refresh of any stale feeds, then return the newest cached items.
// Freshly-fetched items surface on the client's next poll.
//
// `q` searches item title, item summary and SOURCE name (ticket #7). It is
// clamped and LIKE-escaped in listItems, and a term under MIN_QUERY_LEN is
// ignored rather than run — see rssServer.
export async function GET(req: NextRequest) {
  kickRefresh();
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return Response.json({ items: await listItems({ limit, q }) });
}
