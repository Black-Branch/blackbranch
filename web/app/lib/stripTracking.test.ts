// Tracking-param stripping.
//
// The rule: strip on DISPLAY, keep the stored link as typed. The tests split
// along that line — what the reader gets, and what the database keeps.
//
// The tie-breaker running through all of this: a SURVIVING tracking param is a
// small cost, a BROKEN link is a large one. Where a judgement call exists, these
// tests pin the conservative side, not the thorough one.
//
// Run: node --test app/lib/stripTracking.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripTracking } from "./stripTracking.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const clean = (u: string) => stripTracking(u).clean;

// ── What it removes ──────────────────────────────────────────────────────────

test("utm_* goes, by name and by prefix", () => {
  assert.equal(
    clean("https://example.com/p?utm_source=twitter&utm_medium=social&utm_campaign=spring"),
    "https://example.com/p"
  );
  // The list cannot enumerate every variant marketing tools invent; the prefix
  // is unambiguous in a way a bare guess is not.
  assert.equal(clean("https://example.com/p?utm_whatever_is_new=1"), "https://example.com/p");
});

test("ad-click identifiers go", () => {
  for (const p of ["fbclid", "gclid", "msclkid", "twclid", "ttclid", "yclid", "igshid", "dclid"]) {
    assert.equal(clean(`https://example.com/a?${p}=xyz`), "https://example.com/a", `${p} survived`);
  }
});

test("a mixed query keeps the real params and drops only the tracking ones", () => {
  // The common shape, and the one that would be most visibly wrong.
  assert.equal(
    clean("https://shop.example.com/item?id=4821&colour=blue&utm_source=email&fbclid=abc"),
    "https://shop.example.com/item?id=4821&colour=blue"
  );
});

test("a dangling `?` does not survive when the query empties out", () => {
  const r = stripTracking("https://example.com/p?utm_source=x");
  assert.equal(r.clean, "https://example.com/p");
  assert.ok(!r.clean.endsWith("?"), "an empty query string was left behind");
});

// ── What it must NOT remove ──────────────────────────────────────────────────

test("params that could select CONTENT are never touched", () => {
  // The tie-breaker. `id`, `ref`, `source`, `v`, `p`, `q` all look
  // tracking-ish and all route on some site somewhere. Guessing wrong here
  // breaks the link, which is the worse failure.
  for (const q of ["id=7", "ref=nav", "source=rss", "v=abc123", "p=2", "q=search+terms", "page=3"]) {
    const u = `https://example.com/x?${q}`;
    assert.equal(clean(u), u, `${q} was stripped — that can break routing`);
  }
});

test("YouTube's timestamp survives", () => {
  // `t=` must survive: it selects the moment.
  assert.equal(
    clean("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s"
  );
  assert.equal(clean("https://youtu.be/dQw4w9WgXcQ?t=90"), "https://youtu.be/dQw4w9WgXcQ?t=90");
  // …and a real playlist position is not tracking either.
  assert.equal(
    clean("https://www.youtube.com/watch?v=abc&list=PLxyz&index=4"),
    "https://www.youtube.com/watch?v=abc&list=PLxyz&index=4"
  );
});

test("`si` is stripped everywhere, YouTube included", () => {
  // `si` is pure share-attribution and the link works without it, on YouTube
  // too — there is no host-keep exemption. The content-selecting params — v,
  // t, list, index — are pinned by the tests above and must keep surviving.
  assert.equal(clean("https://youtu.be/abc?si=track123"), "https://youtu.be/abc");
  assert.equal(clean("https://www.youtube.com/watch?v=abc&si=track123"),
    "https://www.youtube.com/watch?v=abc");
  assert.equal(clean("https://music.youtube.com/watch?v=abc&si=xyz"),
    "https://music.youtube.com/watch?v=abc");
  assert.equal(clean("https://other.example/x?si=track123"), "https://other.example/x");
});

// ── Leaving things alone ─────────────────────────────────────────────────────

test("a URL with no query is returned untouched, cheaply", () => {
  const u = "https://example.com/a/b/c";
  const r = stripTracking(u);
  assert.equal(r.clean, u);
  assert.deepEqual(r.removed, []);
});

test("a URL with nothing to strip is returned EXACTLY as typed", () => {
  // Not merely equivalent — identical. searchParams re-encodes, and a link
  // that visibly changes shape for no reason makes the whole display look
  // untrustworthy. Only a real removal may rewrite anything.
  // The fixture has to be one that `new URL(x).toString()` genuinely REWRITES,
  // or the test passes whether or not the early return exists. An uppercase host
  // is the simplest such case (toString lowercases it); a URL that round-trips
  // unchanged would catch nothing.
  const upper = "https://Example.COM/p?b=2&a=1";
  assert.notEqual(new URL(upper).toString(), upper, "fixture no longer exercises re-encoding");
  assert.equal(stripTracking(upper).clean, upper,
    "the URL was re-encoded despite nothing being removed");

  const u = "https://example.com/p?b=2&a=1&weird=%20space%20";
  assert.equal(stripTracking(u).clean, u, "the URL was re-encoded despite nothing being removed");
});

test("an unparseable string is left entirely alone", () => {
  const junk = "https://not a url?utm_source=x";
  assert.equal(stripTracking(junk).clean, junk);
});

test("`removed` reports what actually went", () => {
  const r = stripTracking("https://example.com/p?utm_source=a&id=1&fbclid=b");
  assert.deepEqual(r.removed.sort(), ["fbclid", "utm_source"]);
});

// ── the rule, pinned at the call sites ───────────────────────────────────────

test("the STORED message is never rewritten", () => {
  // Strip on display, keep the stored link as typed. Rewriting what somebody
  // actually wrote is unrecoverable, and a moderation review that shows a link
  // the sender did not send is worse than useless.
  //
  // Pinned by absence: no send/ingest path may import this module.
  const senders = [
    "app/api/chat/send/route.ts",
    "app/lib/blocklistReview.ts",
  ];
  for (const f of senders) {
    const src = readFileSync(join(HERE, "..", "..", f.replace(/^app\//, "app/")), "utf8");
    assert.doesNotMatch(src, /stripTracking/,
      `${f} strips tracking params before storing — the stored link must stay as typed`);
  }
});

test("display, href and copy all use the SAME stripped URL", () => {
  // Stripping only the visible text while the href kept its params would be
  // theatre — the click still phones home — and the copy button would hand over
  // a different link than the reader followed.
  const src = readFileSync(join(HERE, "renderText.tsx"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const url = src.slice(src.indexOf('if (seg.t === "url")'), src.indexOf('if (seg.t === "link")'));
  assert.ok(url.length > 100, "could not isolate the url branch");
  assert.match(url, /stripTracking\(seg\.href\)/, "the bare-URL branch no longer strips");
  // One variable feeds all three, so they cannot drift apart.
  // Anchored on the <a>'s own href, not "a cleanHref appears somewhere in the
  // branch" — the copy button also carries one, so the loose version passes
  // with the anchor pointing back at the tracking URL.
  assert.match(url, /href=\{cleanHref\}[\s\S]{0,60}target="_blank"/,
    "the <a> href still carries tracking params");
  assert.doesNotMatch(url, /href=\{seg\.href\}/,
    "something in the bare-URL branch still points at the unstripped href");
  assert.match(url, /elideUrl\(cleanHref\)/, "the display is elided from the UNSTRIPPED url");
  assert.match(url, /CopyLinkButton href=\{cleanHref\}/, "copy hands over the tracking url");

  const link = src.slice(src.indexOf('if (seg.t === "link")'));
  assert.match(link, /stripTracking\(seg\.href\)/, "markdown links are not stripped");
});
