// Tests for URL extraction / preview dedup.
//
// extractUrls had ZERO tests and one live symptom: duplicate preview cards under
// bridged messages, one of them empty.
//
// Run: node --test app/lib/textFormat.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, uniqueUrls } from "./textFormat.ts";

test("the live bug: a markdown link plus its bare URL is ONE preview", () => {
  // The greedy /https?:\/\/[^\s]+/ ran past the closing paren, so this body yielded
  // "…/3m5hh5rnqwk2v)" and "…/3m5hh5rnqwk2v" — two distinct strings, two cards, and
  // the paren one resolved to Bluesky's empty SPA shell.
  const body =
    "[Some post](https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v) " +
    "https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v";
  assert.deepEqual(extractUrls(body), ["https://bsky.app/profile/natalie.sh/post/3m5hh5rnqwk2v"]);
});

test("trailing sentence punctuation is not part of the URL", () => {
  for (const [text, want] of [
    ["see https://example.com/a.", "https://example.com/a"],
    ["see https://example.com/a,", "https://example.com/a"],
    ["see https://example.com/a!", "https://example.com/a"],
    ["(https://example.com/a)", "https://example.com/a"],
    ["“https://example.com/a”…", "https://example.com/a”"],
  ] as [string, string][]) {
    assert.deepEqual(extractUrls(text), [want], `mis-trimmed: ${text}`);
  }
});

test("balanced parens inside a URL are preserved", () => {
  // The regression the naive "strip trailing )" fix would cause.
  const u = "https://en.wikipedia.org/wiki/Mercury_(planet)";
  assert.deepEqual(extractUrls(`look at ${u}`), [u]);
  assert.deepEqual(extractUrls(`look at (${u})`), [u], "an unbalanced wrapper paren still goes");
});

test("dedup ignores differences that are not different pages", () => {
  const same = [
    "https://example.com/post",
    "https://example.com/post/",
    "https://www.example.com/post",
    "https://EXAMPLE.com/post",
    "https://example.com/post#m",
  ];
  assert.equal(uniqueUrls(same).length, 1, "these are all one page");
  assert.equal(uniqueUrls(same)[0], "https://example.com/post", "keeps the first spelling");
});

test("a query string IS a difference", () => {
  assert.equal(
    uniqueUrls(["https://youtu.be/x?t=1", "https://youtu.be/x?t=99"]).length,
    2,
    "different query = different page"
  );
});

test("at most three previews", () => {
  const many = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}`);
  assert.equal(extractUrls(many.join(" ")).length, 3);
});

test("non-http schemes and junk are ignored", () => {
  assert.deepEqual(extractUrls("no links here"), []);
  assert.deepEqual(extractUrls(""), []);
  assert.deepEqual(uniqueUrls(["javascript:alert(1)", "mailto:a@b.c", "not a url"]), []);
});

test("real bridged bodies", () => {
  // Verbatim shapes from our own Synapse rows.
  // The fragment is kept in the URL we hand to LinkPreview — we dedup on it, we do
  // not rewrite what the sender wrote. What matters is that it yields ONE card.
  assert.deepEqual(
    extractUrls(
      "* https://x.com/ScooterCasterNY/status/2070937266462065040#m " +
      "https://x.com/ScooterCasterNY/status/2070937266462065040"
    ),
    ["https://x.com/ScooterCasterNY/status/2070937266462065040#m"],
    "the #m fragment must not create a second card"
  );
  assert.deepEqual(
    extractUrls("Thought this episode was interesting.\nhttps://youtu.be/60psYSeQoK8?t=42"),
    ["https://youtu.be/60psYSeQoK8?t=42"]
  );
});
