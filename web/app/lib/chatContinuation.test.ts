// Guards for the grouped-run continuation line: it carries no glyph, and its
// alignment ships as a user option.
//
// Two things here are load-bearing and neither is obvious from reading the
// code, which is the whole reason this file exists:
//
// The continuation <span> is EMPTY BUT NOT DEAD. Its width is the wrap-indent
//    gutter; deleting it as "an empty span" silently re-aligns every
//    continuation line in every grouped run.
// The class is INVERTED against the setting — `chat-group-flush` is present
//    when "Indent continuations" is OFF. check-prepaint.mjs only proves the
//    pre-paint script READS the key, never that it reads it the right way
//    round, so a mirror written as `=== '1'` would invert the setting on every
//    hard reload and pass the build. That polarity is pinned below.
//
// Run: node --test app/lib/chatContinuation.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the glyph is gone but the spacer element survives", () => {
  const src = read("app", "features", "chat", "ChatMessage.tsx");
  assert.match(src, /className="chat-continuation"/,
    "the continuation spacer was deleted — continuation text will lose the wrap-indent gutter");
  assert.doesNotMatch(src, /›/,
    "the '›' continuation glyph is back in ChatMessage");
  // Inline margins used to fight the CSS (the group rule needed `margin: 0
  // !important` to win). Geometry belongs in one place now.
  assert.doesNotMatch(src, /chat-continuation[^>]*style=/,
    "inline styles are back on the continuation spacer — geometry lives in globals.css");
});

test("registry: groupIndent is pre-paint, roaming, and inverts into the class", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /groupIndent: E\(\{ ls: "chatStyle_groupIndent", prePaint: true,/,
    "groupIndent must be prePaint — it is layout, so a late apply jumps the text on reload");
  assert.doesNotMatch(reg, /groupIndent: E\(\{[^)]*deviceLocal/,
    "groupIndent must ROAM — it is an appearance choice, not a per-device perf one");
  assert.match(reg, /effect: \(v\) => cls\("chat-group-flush", !\(v as boolean\)\)/,
    "the class polarity flipped: chat-group-flush must be added when indenting is OFF");
  assert.match(reg, /groupIndent: true,/,
    "the default must stay TRUE — false would move the layout of every existing grouped user");
});

test("pre-paint mirror restores groupIndent with the SAME polarity as the registry", () => {
  const layout = read("app", "layout.tsx");
  assert.match(
    layout,
    /getItem\('chatStyle_groupIndent'\) === '0'\) document\.documentElement\.classList\.add\('chat-group-flush'\)/,
    "mirror must add chat-group-flush on '0' (setting OFF); '1' here would invert the setting on reload"
  );
});

test("CSS: indent sizes the gutter to the wrap indent, flush removes it", () => {
  const css = read("app", "globals.css");
  assert.match(
    css,
    /\.chat-group-on \.chat-compact \.chat-continuation \{[^}]*width: max\(0px, calc\(var\(--chat-wrap-padding, 0px\) - var\(--chat-ts-shown-w, 0px\)\)\)/,
    "the spacer is the wrap indent minus the time that still shows on a grouped row — that is what aligns it with the wrapped lines above"
  );
  // min-width/padding-right/text-align existed only to keep the glyph legible.
  // Left in place they would over-size the gutter past the wrap indent, which
  // breaks the alignment the rule above claims to provide.
  const indentRule = css.match(/\.chat-group-on \.chat-compact \.chat-continuation \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(indentRule, /min-width|padding-right|text-align/,
    "glyph-era sizing is back; the gutter must equal the wrap indent exactly");
  assert.match(
    css,
    /\.chat-group-on\.chat-group-flush \.chat-compact \.chat-continuation \{\s*display: none !important;\s*\}/,
    "flush variant missing — 'Indent continuations' off must collapse the gutter entirely"
  );
});

test("the toggle is only offered while grouping is on", () => {
  const menu = read("app", "lib", "settingsMenu.ts");
  assert.match(menu, /s\("groupIndent", \(v\) => v\.groupConsecutive\)/,
    "groupIndent must be gated on groupConsecutive — it does nothing when runs aren't grouped");
});
