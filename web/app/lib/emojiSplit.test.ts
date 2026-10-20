// Unit tests for the pure emoji/text splitter. Run with:
//   node --test app/lib/emojiSplit.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitEmoji } from "./emojiSplit.ts";

// Compact view: emoji pieces wrapped in [ ], text pieces raw, joined by "|".
const show = (s: string) =>
  splitEmoji(s).map((p) => (p.emoji ? `[${p.value}]` : p.value)).join("|");
const emojiOf = (s: string) => splitEmoji(s).filter((p) => p.emoji).map((p) => p.value);

test("pure ASCII returns a single text segment (fast path)", () => {
  const out = splitEmoji("hello world");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.emoji, false);
  assert.equal(out[0]!.value, "hello world");
});

test("a basic emoji is isolated with surrounding text kept", () => {
  assert.equal(show("gg \u{1F600} nice"), "gg |[\u{1F600}]| nice");
});

test("a ZWJ family stays ONE emoji token (not split into members)", () => {
  const emoji = emojiOf("\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}");
  assert.equal(emoji.length, 1);
});

test("skin-tone modifier stays attached to its base", () => {
  const emoji = emojiOf("wave \u{1F44B}\u{1F3FD}");
  assert.deepEqual(emoji, ["\u{1F44B}\u{1F3FD}"]);
});

test("a regional-indicator pair is one flag token", () => {
  const emoji = emojiOf("flag \u{1F1FA}\u{1F1F8} usa");
  assert.deepEqual(emoji, ["\u{1F1FA}\u{1F1F8}"]);
});

test("keycap converts but a bare digit does not", () => {
  assert.equal(show("3️⃣ and 7"), "[3️⃣]| and 7");
});

test("bare text symbols (c/r/tm) stay text, VS16 promotes to emoji", () => {
  // Lone (c)(r)(tm) must not become colour images...
  assert.deepEqual(emojiOf("© ® ™"), []);
  // ...but the emoji-presentation form (with VS16) does.
  assert.deepEqual(emojiOf("©️"), ["©️"]);
});

test("adjacent emoji each become their own token", () => {
  assert.deepEqual(emojiOf("\u{1F389}\u{1F389}"), ["\u{1F389}", "\u{1F389}"]);
});

test("CJK/kana text is left intact (scan false-positive, regex matches nothing)", () => {
  const out = splitEmoji("日本語 text");
  assert.equal(out.length, 1);
  assert.equal(out[0]!.emoji, false);
});

test("emoji at the very start (no leading text) works", () => {
  assert.equal(show("\u{1F525}yo"), "[\u{1F525}]|yo");
});
