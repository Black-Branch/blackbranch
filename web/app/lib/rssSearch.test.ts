import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { xmlText, normalizeItems } from "./rssItemFields.ts";
import { searchPattern, MIN_QUERY_LEN } from "./rssSearch.ts";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** rows[i], but it fails the test rather than the type-checker when the row the
 *  assertion is about does not exist. */
function at<T>(rows: readonly T[], i = 0): T {
  assert.ok(rows.length > i, `expected at least ${i + 1} row(s), got ${rows.length}`);
  return rows[i] as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// xmlText — the parse hazard that killed The Intercept's feed for four weeks.
// ─────────────────────────────────────────────────────────────────────────────

test("xmlText: an attribute-only element yields empty string, not a throw", () => {
  // The EXACT shape rss-parser produces for a real feed's
  // `<guid isPermaLink="false"></guid>`. `(it.guid || ...).slice(...)` on this
  // object throws "…slice is not a function", failing the WHOLE poll.
  const intercept = { $: { isPermaLink: "false" } };
  assert.equal(xmlText(intercept), "");
});

test("xmlText: an element with BOTH text and attributes yields its text", () => {
  assert.equal(xmlText({ _: "urn:uuid:42", $: { isPermaLink: "false" } }), "urn:uuid:42");
});

test("xmlText: plain strings pass through untouched", () => {
  assert.equal(xmlText("https://example.com/a"), "https://example.com/a");
  assert.equal(xmlText(""), "");
});

test("xmlText: every other shape degrades to empty rather than throwing", () => {
  for (const v of [null, undefined, 42, [], ["a"], { $: {} }, { _: 7 }, true]) {
    assert.equal(xmlText(v), "", `expected "" for ${JSON.stringify(v)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeItems — per-item degradation. The regression was that ONE bad field
// on ONE item discarded the entire poll.
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeItems: an attribute-only guid falls back to the link, item survives", () => {
  const rows = normalizeItems([
    {
      guid: { $: { isPermaLink: "false" } },
      link: "https://theintercept.com/2026/08/04/story/",
      title: "A headline",
      contentSnippet: "A summary.",
    },
  ]);
  assert.equal(rows.length, 1, "the Intercept-shaped item was dropped");
  assert.equal(at(rows).fields.guid, "https://theintercept.com/2026/08/04/story/");
  assert.equal(at(rows).fields.title, "A headline");
  assert.equal(at(rows).fields.link, "https://theintercept.com/2026/08/04/story/");
});

test("normalizeItems: one unusable item does not take the rest of the poll with it", () => {
  const rows = normalizeItems([
    { guid: { $: {} }, link: { $: {} }, title: { $: {} } }, // no identity at all
    { guid: "g2", title: "Second story" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(at(rows).fields.guid, "g2");
});

test("normalizeItems: keeps the source item so the caller can still read image/date", () => {
  const src = { guid: "g", title: "T", isoDate: "2026-08-04T00:00:00.000Z" };
  const rows = normalizeItems([src]);
  assert.equal(at(rows).item, src, "the original item must be passed through by reference");
});

test("normalizeItems: drops a repeated guid — one INSERT cannot hit a row twice", () => {
  // ON CONFLICT raises "cannot affect row a second time" if a guid repeats
  // inside a single multi-row statement, so this dedupe is load-bearing.
  const rows = normalizeItems([
    { guid: "same", title: "First" },
    { guid: "same", title: "Second" },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(at(rows).fields.title, "First", "the first occurrence should win");
});

test("normalizeItems: an item with no title is dropped (the column is NOT NULL)", () => {
  assert.equal(normalizeItems([{ guid: "g", link: "https://x.test/" }]).length, 0);
});

test("normalizeItems: clamps to the stored column widths", () => {
  const rows = normalizeItems([
    { guid: "g".repeat(1500), title: "t".repeat(900), contentSnippet: "s".repeat(1500) },
  ]);
  assert.equal(at(rows).fields.guid.length, 1000);
  assert.equal(at(rows).fields.title.length, 500);
  assert.equal(at(rows).fields.summary!.length, 1000);
});

test("normalizeItems: an empty summary is stored as NULL, not an empty string", () => {
  const rows = normalizeItems([{ guid: "g", title: "T", contentSnippet: "" }]);
  assert.equal(at(rows).fields.summary, null);
  assert.equal(at(rows).fields.link, null);
});

test("normalizeItems: a WordPress feed whose every guid is empty yields every item", () => {
  // Guards the fix end-to-end against feed XML rather than a hand-made object — the failure was in
  // what the FEED ships: WordPress writes <guid isPermaLink="false"></guid>, attribute-only and
  // EMPTY, on every item. The fixture is synthetic, in that exact shape (a captured third-party
  // feed is someone else's text to republish).
  const xml = read("app", "lib", "__fixtures__", "wordpress-feed.xml");
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const body = m[1] ?? "";
    const pick = (tag: string) =>
      body.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`))?.[1] ?? "";
    return {
      // Every <guid> in this feed is attribute-only and EMPTY — the object case.
      guid: { $: { isPermaLink: "false" } },
      link: pick("link"),
      title: pick("title"),
    };
  });
  assert.equal(items.length, 3, `fixture parsed ${items.length} items`);
  assert.equal((xml.match(/<guid isPermaLink="false"><\/guid>/g) ?? []).length, 3, "every guid is the empty, attribute-only one");
  const rows = normalizeItems(items);
  assert.equal(rows.length, items.length, "items were lost to the guid coercion");
  assert.ok(rows.every((r) => r.fields.guid.startsWith("https://")), "guid did not fall back to link");
});

// ─────────────────────────────────────────────────────────────────────────────
// searchPattern
// ─────────────────────────────────────────────────────────────────────────────

test("searchPattern: a term shorter than the minimum means NO filter, not no results", () => {
  assert.equal(searchPattern(""), null);
  assert.equal(searchPattern("   "), null);
  assert.equal(searchPattern("g"), null, "a single character cannot use a trigram index");
  assert.equal(MIN_QUERY_LEN, 2);
});

test("searchPattern: a real term becomes a contains-pattern", () => {
  assert.equal(searchPattern("gaza"), "%gaza%");
  assert.equal(searchPattern("  pew  "), "%pew%", "the term should be trimmed");
});

test("searchPattern: LIKE metacharacters are escaped, so % is a percent sign", () => {
  // Without this a search for "%" returns every row in the table.
  assert.equal(searchPattern("100%"), "%100\\%%");
  assert.equal(searchPattern("a_b"), "%a\\_b%");
  assert.equal(searchPattern("c\\d"), "%c\\\\d%");
  // A lone "%" is under MIN_QUERY_LEN, so it never reaches the database at all.
  assert.equal(searchPattern("%"), null);
  assert.equal(searchPattern("%%"), "%\\%\\%%");
});

// ─────────────────────────────────────────────────────────────────────────────
// Wiring — the pieces above are only worth anything if they are actually used.
// ─────────────────────────────────────────────────────────────────────────────

test("rssServer: the search SQL declares ESCAPE and covers title, summary AND source", () => {
  const src = read("app", "lib", "rssServer.ts");
  const where = src.match(/AND \(\$2::text IS NULL[\s\S]*?\)\)/)?.[0];
  assert.ok(where, "the q predicate is gone from listItems");
  for (const col of ["i.title ILIKE $2", "i.summary ILIKE $2", "i.feed_id = ANY($3::int[])"]) {
    assert.ok(where.includes(col), `${col} is not part of the search`);
  }
  // The escape character only works if BOTH halves agree: searchPattern writes
  // backslashes, and without ESCAPE Postgres would not treat them as escapes.
  assert.equal(
    (where.match(/ESCAPE '\\\\'/g) ?? []).length, 2,
    "every ILIKE in the item search must declare ESCAPE '\\'",
  );
  assert.ok(src.includes("searchPattern(q)"), "listItems no longer builds its pattern via searchPattern");
  assert.match(read("app", "lib", "rssServer.ts"), /ILIKE \$1 ESCAPE '\\\\'/,
    "the source-name lookup dropped its ESCAPE");
});

test("rssServer: the source match stays OUT of the joined OR, or the indexes go unused", () => {
  // MEASURED, not stylistic. `OR f.title ILIKE $2` turns the whole
  // disjunction into a join filter that no index can serve: 29.8ms per rare
  // term versus 0.12ms for the array form. Same for an `IN (SELECT ...)`,
  // which becomes a SubPlan branch and collapses the BitmapOr just as badly.
  const src = read("app", "lib", "rssServer.ts");
  const where = src.match(/AND \(\$2::text IS NULL[\s\S]*?\)\)/)?.[0] ?? "";
  assert.doesNotMatch(where, /f\.title ILIKE/,
    "the source name is back inside the joined OR — the trigram indexes are now dead");
  assert.doesNotMatch(where, /IN \(SELECT/,
    "a subquery branch collapses the BitmapOr back to a full table walk");
  assert.match(src, /feedIds = pattern \? await feedsNamed\(pattern\) : \[\]/,
    "the source ids are no longer pre-resolved outside the item query");
});

test("rssServer: the insert goes through normalizeItems, never a raw it.guid", () => {
  const src = read("app", "lib", "rssServer.ts");
  assert.ok(src.includes("normalizeItems("), "the poll no longer normalizes its items");
  assert.doesNotMatch(
    src, /it\.guid \|\| it\.link/,
    "the raw `it.guid || it.link` chain is back — it throws on an attribute-only guid",
  );
  assert.doesNotMatch(
    src, /it\.title!/,
    "`it.title!` asserts a string the parser does not guarantee",
  );
});

test("/api/rss/items: forwards q to listItems", () => {
  const src = read("app", "api", "rss", "items", "route.ts");
  assert.match(src, /searchParams\.get\("q"\)/, "the route never reads q");
  assert.match(src, /listItems\(\{[^}]*\bq\b/, "q is read but not passed to listItems");
});

test("useRssFeed: sends q, and debounces it so typing is not one request per key", () => {
  const src = read("app", "lib", "useRssFeed.ts");
  assert.match(src, /q=\$\{encodeURIComponent\(q\)\}/, "the term is not URL-encoded into the request");
  assert.match(src, /setTimeout\(load, SEARCH_DEBOUNCE_MS\)/, "the search is not debounced");
  assert.match(src, /clearTimeout\(first\)/, "the debounce timer is not cleared on cleanup");
  assert.match(src, /\}, \[active, q\]\);/, "the effect does not re-run when the term changes");
});

test("FeedPanel: the ticker view never carries a search term", () => {
  // The two hosts share one hook. If the ticker passed `query` through, a term
  // typed in the mobile list would silently filter the desktop dock's crawl.
  const src = read("app", "components", "FeedPanel", "index.tsx");
  assert.match(src, /useRssFeed\(active, searching \? query : ""\)/,
    "the ticker is no longer pinned to an empty query");
  assert.match(src, /const searching = view === "list"/, "the list-only gate is gone");
  assert.match(src, /type="search"/, "the search input is missing from the panel");
});
