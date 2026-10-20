// Server-only RSS pipeline for the under-video feed panel. Admin-curated feeds
// (site.rss_feeds) are polled on read — see /api/rss/items — at most once per
// POLL_INTERVAL_MS each, fetched through safeFetch (SSRF-guarded; never let the
// parser fetch directly) and upserted into site.rss_items deduped on (feed,guid).
// Web owns site.* — no stream-api involvement.
import Parser from "rss-parser";
import pool from "@/lib/db";
import { safeFetch } from "@/app/lib/ssrf";
import { readBodyCapped } from "@/app/lib/boundedBody";

// A busy feed with full-content items runs to a few MB; past this it is not a feed we keep up with.
const FEED_MAX_BYTES = 8 * 1024 * 1024;
import { normalizeItems } from "@/app/lib/rssItemFields";
import { searchPattern } from "@/app/lib/rssSearch";

const POLL_INTERVAL_MS = 3 * 60_000; // refresh a given feed at most this often
const FETCH_TIMEOUT_MS = 10_000;
const MAX_ITEMS_PER_FEED = 40; // keep only the newest N per refresh
// A realistic UA — some publishers 403 a bot-looking agent.
const FEED_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type MediaField = { $?: { url?: string } } | undefined;
type ParsedItem = Parser.Item & { mediaThumbnail?: MediaField; mediaContent?: MediaField };

const parser: Parser<unknown, ParsedItem> = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  customFields: { item: [["media:thumbnail", "mediaThumbnail"], ["media:content", "mediaContent"]] },
});

export type RssItem = {
  id: string;
  feedId: number;
  feedTitle: string;
  guid: string;
  title: string;
  link: string | null;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
};

// Prefer an explicit image enclosure / media tag; fall back to the first <img>
// in the HTML body. https-only so it can't trip mixed-content blocking in <img>.
function pickImage(it: ParsedItem): string | null {
  const enc = it.enclosure;
  const candidates = [
    enc?.url && (enc.type ?? "").startsWith("image") ? enc.url : null,
    it.mediaThumbnail?.$?.url ?? null,
    it.mediaContent?.$?.url ?? null,
    (typeof it.content === "string" ? it.content.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] : null) ?? null,
  ];
  for (const c of candidates) if (typeof c === "string" && c.startsWith("https://")) return c;
  return null;
}

// Fetch + parse + upsert a single feed. Any failure records poll_error instead of
// throwing, and always advances last_polled_at so a broken feed isn't re-hammered.
async function refreshOne(feedId: number, url: string): Promise<void> {
  try {
    const res = await safeFetch(url, { headers: { "user-agent": FEED_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const xml = await readBodyCapped(res, FEED_MAX_BYTES);
    if (xml === null) throw new Error("too_large");
    const parsed = await parser.parseString(xml);
    // One multi-row INSERT per poll instead of a round-trip per item (items are
    // bounded by MAX_ITEMS_PER_FEED; ON CONFLICT keeps re-polls idempotent).
    // Coercion, clamping and the required in-batch guid dedupe all live in
    // normalizeItems — see rssItemFields.ts for why a raw `it.guid` cannot be
    // trusted to be a string (it killed The Intercept's poll for four weeks).
    const items = normalizeItems((parsed.items ?? []).slice(0, MAX_ITEMS_PER_FEED));
    if (items.length) {
      await pool.query(
        `INSERT INTO site.rss_items (feed_id, guid, title, link, summary, image_url, published_at)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[])
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId,
         items.map(({ fields }) => fields.guid),
         items.map(({ fields }) => fields.title),
         items.map(({ fields }) => fields.link),
         items.map(({ fields }) => fields.summary),
         items.map(({ item }) => pickImage(item)),
         items.map(({ item }) => item.isoDate ?? null)],
      );
    }
    await pool.query(`UPDATE site.rss_feeds SET last_polled_at = now(), poll_error = NULL WHERE id = $1`, [feedId]);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "fetch_failed").slice(0, 300);
    await pool
      .query(`UPDATE site.rss_feeds SET last_polled_at = now(), poll_error = $2 WHERE id = $1`, [feedId, msg])
      .catch(() => {});
  }
}

async function refreshStaleFeeds(): Promise<void> {
  const { rows } = await pool
    .query<{ id: number; url: string }>(
      `SELECT id, url FROM site.rss_feeds
        WHERE enabled AND (last_polled_at IS NULL
          OR last_polled_at < now() - ($1::int * interval '1 millisecond'))`,
      [POLL_INTERVAL_MS],
    )
    .catch(() => ({ rows: [] as { id: number; url: string }[] }));
  await Promise.all(rows.map((f) => refreshOne(f.id, f.url)));
}

// Fire-and-forget refresh with a per-process in-flight guard so a burst of reads
// doesn't stack overlapping fetch passes. Cross-process coordination is the DB
// last_polled_at gate. The route never awaits this — it returns current items.
let refreshing = false;
export function kickRefresh(): void {
  if (refreshing) return;
  refreshing = true;
  void refreshStaleFeeds().finally(() => { refreshing = false; });
}

/** Ids of the enabled sources whose NAME matches the term. Resolved separately,
 *  and cheaply — rss_feeds is a dozen rows — so the item query's search
 *  predicate stays entirely on rss_items columns. See listItems for why that
 *  matters far more than the extra round trip. */
async function feedsNamed(pattern: string): Promise<number[]> {
  const { rows } = await pool
    .query<{ id: number }>(
      `SELECT id FROM site.rss_feeds WHERE enabled AND title ILIKE $1 ESCAPE '\\'`,
      [pattern],
    )
    .catch(() => ({ rows: [] as { id: number }[] }));
  return rows.map((r) => Number(r.id));
}

/**
 * Newest items across all enabled feeds, optionally filtered by a search term.
 *
 * `q` matches the item title, its summary, OR the SOURCE name — typing a
 * publication's name finds that publication's stories.
 *
 * Substring ILIKE rather than full-text search, matching the mod chat-history
 * search (/api/mod/chat-history) and accelerated the same way, by trigram
 * indexes. Full-text would stem and match on word boundaries, which is better
 * for prose and worse here: headlines are short, and people type partial names
 * ("netanya", "trans") and expect a hit.
 *
 * WHY THE SOURCE MATCH IS A PRE-RESOLVED ARRAY AND NOT PART OF THE OR.
 * The obvious spelling is `... OR f.title ILIKE $2` against the joined table.
 * MEASURED (15,794 items): that makes the whole disjunction a JOIN FILTER,
 * which cannot be pushed into any index, so the trigram indexes go completely
 * unused and every rare term walks the entire table:
 *
 *     ... OR f.title ILIKE $2            → Seq/full walk    29.8 ms
 *     ... OR i.feed_id = ANY($3::int[])  → BitmapOr on both  0.12 ms
 *
 * Written this way all three branches are rss_items predicates, so the planner
 * builds a BitmapOr over idx_rss_items_title_trgm + idx_rss_items_summary_trgm.
 * A CTE or an `IN (SELECT ...)` does NOT work either — either one becomes a
 * SubPlan branch and the BitmapOr collapses back to a full walk (measured at
 * 29.5 ms). The ids have to arrive as a plain parameter.
 */
export async function listItems({ limit = 50, q = "" }: { limit?: number; q?: string } = {}): Promise<RssItem[]> {
  const lim = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);
  // null = do not filter. A term under MIN_QUERY_LEN is treated as no search at
  // all, NOT as an empty result — the list stays populated while someone is
  // still typing the first letter. See rssSearch.ts.
  const pattern = searchPattern(q);
  // Only pay for the extra query when actually searching.
  const feedIds = pattern ? await feedsNamed(pattern) : [];
  const { rows } = await pool
    .query<{
      id: string; feed_id: number; feed_title: string; guid: string; title: string;
      link: string | null; summary: string | null; image_url: string | null; published_at: Date | null;
    }>(
      `SELECT i.id, i.feed_id, f.title AS feed_title, i.guid, i.title, i.link,
              i.summary, i.image_url, i.published_at
         FROM site.rss_items i JOIN site.rss_feeds f ON f.id = i.feed_id
        WHERE f.enabled
          AND ($2::text IS NULL
               OR i.title ILIKE $2 ESCAPE '\\'
               OR i.summary ILIKE $2 ESCAPE '\\'
               OR i.feed_id = ANY($3::int[]))
        ORDER BY i.published_at DESC NULLS LAST, i.fetched_at DESC
        LIMIT $1`,
      [lim, pattern, feedIds],
    )
    .catch(() => ({ rows: [] as never[] }));
  return rows.map((r) => ({
    id: String(r.id),
    feedId: Number(r.feed_id),
    feedTitle: r.feed_title,
    guid: r.guid,
    title: r.title,
    link: r.link,
    summary: r.summary,
    imageUrl: r.image_url,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  }));
}
