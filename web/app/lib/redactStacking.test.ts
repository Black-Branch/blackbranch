// Redacted bars must paint UNDERNEATH emotes and usernames.
//
// Why it matters: block glyphs are SOLID opaque ink filling ~1.31em of the line
// box, and emotes are drawn in a zero-height wrapper with `overflow: visible`
// and `translateY(-50%)` so they deliberately spill outside their own line —
// that trick is what keeps line-height constant as emote size changes. Where the
// two meet, whichever paints later wins, and an opaque block winning over
// someone's emote or their name is never the right outcome.
//
// These are source-level assertions because the failure is invisible in every
// other kind of test: a class that exists in CSS but is never applied in the
// markup is a silent no-op.
//
// Run: node --test app/lib/redactStacking.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripCssComments } from "./testSource.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "../globals.css"), "utf8");
const render = readFileSync(join(HERE, "./renderText.tsx"), "utf8");

test("the lift rule exists and names both the header and the emote", () => {
  const rule = css.slice(css.indexOf(".chat-msg-header,\n.chat-emote-el"));
  assert.ok(rule.startsWith(".chat-msg-header,\n.chat-emote-el"), "the rule must exist");
  const block = rule.slice(0, rule.indexOf("}") + 1);
  assert.match(block, /position:\s*relative/, "z-index needs a positioned element to apply to");
  assert.match(block, /z-index:\s*1/, "and must actually lift them");
});

test("the class is APPLIED in the markup, not just defined in CSS", () => {
  // The whole fix is one class name matching in two files. A CSS rule for a
  // class nothing renders is a no-op that looks completely fine in review, in
  // the diff, and in the stylesheet — this repo has already lost months to
  // exactly that shape (`font-mono` resolving to an undefined var).
  const uses = render.match(/className="chat-emote-el"/g) ?? [];
  assert.equal(uses.length, 2,
    "BOTH emote branches (plain and layered/overlay) must carry the class");
});

test("the cipher itself stays unpositioned", () => {
  // The cipher cannot be pushed DOWN by giving it a z-index: a positioned
  // element with `z-index: 0` joins the positioned layer, which paints ABOVE
  // ordinary inline content — the exact opposite of the intent. The only way
  // down is to lift its neighbours, so .redact-text must stay static.
  // .redact-text has no rule of its own (opened text is the row's own look),
  // so this scans EVERY rule whose selector names a redact class — the parts
  // and the bars both.
  // Guard the anchor: with no rules found the negatives below pass on nothing.
  // Comments stripped first: a comment mentioning `.redact-text` would
  // otherwise be read as a selector and swallow the next rule (the lift).
  const bare = stripCssComments(css);
  const blocks = [...bare.matchAll(/^[^{}\n]*\.redact-(?:text|bar)[^{]*\{[^}]*\}/gm)].map((m) => m[0]);
  assert.ok(blocks.length >= 2, `found ${blocks.length} redact rules — the scan is looking in the wrong place`);
  for (const b of blocks) {
    assert.ok(!/position:\s*(relative|absolute|sticky|fixed)/.test(b),
      `positioning a redact rule would raise it above the very things it must sit under:\n${b}`);
    assert.ok(!/z-index/.test(b), `and a z-index on it would do the same:\n${b}`);
  }
});
