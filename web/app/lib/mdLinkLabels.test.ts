// Multi-word markdown labels: `[two words or more](link)`.
//
// THE ROOT CAUSE IS THE TOKENIZER, NOT THE REGEX, and that is the thing this
// file is really guarding. `MD_LINK_RE`'s label group is `[^\]]+`, which
// matches spaces — but only if the token it is handed contains one, and a line
// split on spaces first never hands it such a token (the pattern is anchored
// at both ends). Loosening the regex would change nothing.
//
// The tokenizer runs on EVERY chat message, so the property that matters most is
// that it is byte-identical to `split(" ")` everywhere a markdown link is not
// involved. Emotes, mentions, double-spaces and the `leading` flag all depend on
// its exact behaviour.
//
// Run: node --test app/lib/mdLinkLabels.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { splitTokens } from "./lineTokens.ts";
import { deceptiveLinkHost, linkDestinationHost } from "./linkGuard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── The tokenizer is split(" ") plus one exception ───────────────────────────

test("with no markdown link, tokenizing is IDENTICAL to split(\" \")", () => {
  // The regression that would be worst and quietest: this runs on every
  // message, and emote/mention/leading handling all assume split(" ") exactly.
  const cases = [
    "", " ", "  ", "hello", "hello world", "a  b", "a   b",
    " leading", "trailing ", " both ", "a\tb", "KEKW KEKW",
    "@user hi", "https://a.test/x", "[notalink", "]weird[", "a ] b [ c",
    "[label](not-a-url)", "[a](ftp://x.test)", "text[a](https://x.test)more",
    "emoji 🎉 here", "multi  space   run", "]",
  ];
  for (const c of cases) {
    assert.deepEqual(splitTokens(c), c.split(" "), `diverged from split(" ") for ${JSON.stringify(c)}`);
  }
});

test("a markdown link survives tokenization as ONE token", () => {
  assert.deepEqual(splitTokens("[two words](https://a.test/x)"), ["[two words](https://a.test/x)"]);
  assert.deepEqual(
    splitTokens("see [a much longer label](https://a.test/x) here"),
    ["see", "[a much longer label](https://a.test/x)", "here"]
  );
  // Single-token labels keep working — that is the case that already shipped.
  assert.deepEqual(splitTokens("[one](https://a.test/x)"), ["[one](https://a.test/x)"]);
});

test("two links on one line each stay whole", () => {
  assert.deepEqual(
    splitTokens("[a b](https://x.test/1) and [c d](https://y.test/2)"),
    ["[a b](https://x.test/1)", "and", "[c d](https://y.test/2)"]
  );
});

test("a link is only kept whole when SPACE-DELIMITED", () => {
  // The invariant the rest of the tokenizer depends on: consecutive tokens are
  // separated by exactly one space, which is what `leading` encodes. A link
  // token butting against adjacent text would make `leading` insert a space
  // nobody typed. This is the same boundary the anchored regex enforces.
  assert.deepEqual(splitTokens("x[a b](https://t.test/1)"), "x[a b](https://t.test/1)".split(" "),
    "a link glued to preceding text must fall back to plain split");
  assert.deepEqual(splitTokens("[a b](https://t.test/1)x"), "[a b](https://t.test/1)x".split(" "),
    "a link glued to trailing text must fall back to plain split");
});

test("an unterminated or non-http bracket does not swallow the rest of the line", () => {
  // The failure mode to avoid: a stray `[` eating everything after it.
  for (const c of [
    "[unclosed label https://a.test/x and more words",
    "[label](javascript:alert(1)) rest",
    "[label](ftp://a.test) rest",
    "[](https://a.test/x)",
  ]) {
    assert.deepEqual(splitTokens(c), c.split(" "), `swallowed the line for ${JSON.stringify(c)}`);
  }
});

test("double spaces and edges survive, because leading depends on them", () => {
  assert.deepEqual(splitTokens("a  [x y](https://t.test/1)  b"),
    ["a", "", "[x y](https://t.test/1)", "", "b"]);
  assert.deepEqual(splitTokens("[x y](https://t.test/1) "), ["[x y](https://t.test/1)", ""]);
});

// ── The destination chip ─────────────────────────────────────────────────────

test("a friendly label shows where the link actually goes", () => {
  // The risk multi-word labels CREATE. "click here for the thing" makes no
  // domain claim, so the deception test passes cleanly — and the reader has no
  // idea where it goes.
  assert.equal(deceptiveLinkHost("click here for the thing", "https://unknown.test/x"), null,
    "precondition: a claimless label is not deceptive");
  assert.equal(linkDestinationHost("click here for the thing", "https://unknown.test/x"), "unknown.test");
});

test("the chip is omitted when the label already names the destination", () => {
  // A chip on every link is a chip nobody reads — the same reasoning as the
  // parenthesized-handle carve-out in deceptiveLinkHost.
  assert.equal(linkDestinationHost("example.com", "https://example.com/x"), null);
  assert.equal(linkDestinationHost("read it on example.com today", "https://example.com/x"), null);
  assert.equal(linkDestinationHost("docs.example.com", "https://example.com/x"), null,
    "a subdomain claim still identifies the destination");
  assert.equal(linkDestinationHost("example.com", "https://www.example.com/x"), null,
    "www must not make an honest label look claimless");
});

test("an unparseable href gets no chip rather than a broken one", () => {
  assert.equal(linkDestinationHost("label", "not a url"), null);
});

test("deceptive links keep the WARNING and get no neutral chip", () => {
  // Both at once would be noise, and the neutral one would soften the alarm.
  const label = "paypal.com";
  const href = "https://evil.test/x";
  assert.equal(deceptiveLinkHost(label, href), "evil.test", "precondition: this is deceptive");

  const src = readFileSync(join(HERE, "renderText.tsx"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  // The guards are fed `cleanHref`, the URL the reader actually clicks.
  // Stripping does not change the host, so neither guard behaves differently;
  // feeding them the same string the click follows is what stops the two from
  // ever diverging.
  assert.match(src, /const destHost = realHost \? null : linkDestinationHost\(label, cleanHref\)/,
    "the neutral chip is no longer suppressed on a deceptive link");
});

// ── The link-label guard's ordering, which matters MORE with long labels ─────

test("the label is bidi-stripped BEFORE either guard sees it", () => {
  // A longer, friendlier label is a BETTER phishing surface, not a worse one,
  // so this ordering matters more with multi-word labels. A bidi control
  // inside the label reverses how a domain READS without changing the bytes.
  const src = readFileSync(join(HERE, "renderText.tsx"), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//"))
    .map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  const strip = src.indexOf("const label = stripBidiControls(seg.label)");
  const deceptive = src.indexOf("deceptiveLinkHost(label, cleanHref)");
  const dest = src.indexOf("linkDestinationHost(label, cleanHref)");
  assert.ok(strip !== -1, "the label is no longer bidi-stripped");
  assert.ok(deceptive > strip, "the link-label phishing guard reads the RAW label — bidi walks straight past it");
  assert.ok(dest > strip, "the destination chip reads the raw label");
  // Both guards must be fed `label`, never `seg.label`.
  assert.doesNotMatch(src, /deceptiveLinkHost\(seg\.label/, "the phishing guard is fed the unstripped label");
  assert.doesNotMatch(src, /linkDestinationHost\(seg\.label/, "the chip is fed the unstripped label");
});

test("the tokenizer's pattern and the renderer's pattern are the SAME shape", () => {
  // Loosening the tokenizer's href to accept any scheme would break no other
  // test, because the strict MD_LINK_RE in renderText still decides what
  // becomes an <a> — so there is no security hole. But the two patterns
  // deciding DIFFERENT things is a real defect of its own: the tokenizer would
  // keep `[a b](ftp://x)` whole while the renderer refuses it, and the token
  // would silently render as one text run instead of the words the user typed,
  // changing spacing for a string nobody could see was special.
  //
  // The invariant is that the head pattern is the renderer's pattern minus its
  // end anchor. Pin it structurally rather than by outcome, because the outcome
  // is exactly what a divergence hides.
  const tok = readFileSync(join(HERE, "lineTokens.ts"), "utf8");
  const rt = readFileSync(join(HERE, "renderText.tsx"), "utf8");

  const headSrc = tok.match(/const MD_LINK_HEAD_RE = (\/.*\/);/)?.[1];
  const fullSrc = rt.match(/const MD_LINK_RE = (\/.*\/);/)?.[1];
  assert.ok(headSrc, "MD_LINK_HEAD_RE not found — was it renamed?");
  assert.ok(fullSrc, "MD_LINK_RE not found — was it renamed?");
  assert.equal(
    headSrc,
    fullSrc!.replace(/\$\/$/, "/"),
    "the tokenizer and the renderer disagree about what a markdown link is"
  );
});
