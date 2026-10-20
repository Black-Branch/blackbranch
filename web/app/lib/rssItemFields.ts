// Field coercion + dedupe for parsed RSS items.
//
// Split out of rssServer.ts so it can be unit-tested: rssServer imports the pg
// pool at module load, so importing it from a node test would open a database
// connection just to check string handling.
//
// WHY THIS EXISTS — rss-parser DOES NOT ALWAYS HAND BACK A STRING.
// It parses through xml2js, which represents any element carrying an ATTRIBUTE
// as an object: `{ _: "the text", $: { ...attrs } }`, and with no text content
// at all, just `{ $: { ...attrs } }` — no `_` key whatsoever.
//
// A real feed ships:
//     <guid isPermaLink="false"></guid>
// which parses to `{ "$": { "isPermaLink": "false" } }` — a TRUTHY OBJECT. A
// read like `(it.guid || it.link || it.title || "").slice(0, 1000)` short-
// circuits on that object and `.slice` throws:
//     "(t.guid || t.link || t.title || "").slice is not a function"
//
// That throws out of the whole map(), so refreshOne's catch records it in
// site.rss_feeds.poll_error and NO items are inserted — the failure is not
// scoped to the one bad field, it kills the ENTIRE feed, while the panel looks
// fine because the other sources keep filling it.
//
// So a per-item parse hazard must degrade per-item. Coerce at the boundary,
// drop the individual row that cannot be made sense of, and let the rest of
// the poll through.

/** Longest value each column keeps — mirrors the site.rss_items text columns. */
const GUID_MAX = 1000;
const TITLE_MAX = 500;
const SUMMARY_MAX = 1000;

/** The subset of a parsed item this module reads. Deliberately `unknown` — the
 *  entire point is that the parser's types promise `string` and it can lie. */
export type RawItem = {
  guid?: unknown;
  link?: unknown;
  title?: unknown;
  contentSnippet?: unknown;
};

export type ItemFields = {
  guid: string;
  title: string;
  link: string | null;
  summary: string | null;
};

/**
 * The text of a parsed XML value, whatever shape it arrived in.
 *
 * Handles the three real cases: a plain string, xml2js's `{ _: text, $: attrs }`
 * for an element with attributes, and that same object with NO text at all.
 * Anything else (number, array, null) yields "" so the caller's `||` fallback
 * chain can move on to the next field instead of throwing.
 */
// @test-only rssSearch.test.ts feeds it the object-shaped element that killed a poll.
export function xmlText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const inner = (v as { _?: unknown })._;
    if (typeof inner === "string") return inner;
  }
  return "";
}

/**
 * Coerce, clamp and dedupe a poll's worth of items, keeping each source item
 * paired with its fields so the caller can still read image/date off the original.
 *
 * Drops an item only when it has no usable identity (guid/link/title all empty)
 * or no title — the two things the row genuinely cannot be stored without.
 *
 * The dedupe is REQUIRED, not defensive: the insert is a single multi-row
 * statement, and a guid repeated within one statement makes ON CONFLICT raise
 * "cannot affect row a second time" rather than skip it.
 */
export function normalizeItems<T extends RawItem>(raw: readonly T[]): { item: T; fields: ItemFields }[] {
  const seen = new Set<string>();
  const out: { item: T; fields: ItemFields }[] = [];
  for (const item of raw) {
    // Identity falls back guid → link → title, so a feed like The Intercept's
    // (attribute-only, empty guid) is identified by its link instead of dropped.
    const guid = (xmlText(item.guid) || xmlText(item.link) || xmlText(item.title)).slice(0, GUID_MAX);
    const title = xmlText(item.title).slice(0, TITLE_MAX);
    if (!guid || !title || seen.has(guid)) continue;
    seen.add(guid);
    out.push({
      item,
      fields: {
        guid,
        title,
        link: xmlText(item.link) || null,
        summary: xmlText(item.contentSnippet).slice(0, SUMMARY_MAX) || null,
      },
    });
  }
  return out;
}
