// Device bugs seen on real phones. The Sending… removal is pinned in
// chatSendFeedback.test.ts where the state it reverses is pinned.
//
// Run: node --test app/lib/polishFollowups.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("1: the global focus ring excludes the composer field — no double ring", () => {
  // Browsers treat ANY focus on an editable element as :focus-visible, so the
  // item-26 global rule was a POINTER rule for text fields: tapping the
  // composer drew the accent outline around the border that already carries
  // the field's focus (two rings on device). The exclusion lives in the
  // SELECTOR — one rule, not a second outline:none fighting the first.
  // Keyboard focus on the field stays visible via its own border-brighten.
  const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
  assert.match(css, /:focus-visible:not\(\.chat-input-field\)\s*\{/,
    "the global :focus-visible rule no longer excludes .chat-input-field — the composer double-ring is back");
  assert.doesNotMatch(css, /(^|\n):focus-visible\s*\{/,
    "a bare global :focus-visible rule exists alongside the excluding one — the ring is back on the field");
});

test("2: the row toolbar carries copy; pin/delete live only behind the mod ⋯", () => {
  // A two-step delete in the bar arms INVISIBLY on touch: a "tap again to
  // confirm" in title=/aria-label is something no phone ever shows, so to a
  // mod on mobile the button simply does nothing. So copy takes the bar slot
  // (it works for every viewer), and pin/delete live only in the ⋯ menu,
  // whose armed state changes the visible label text.
  const src = read("app", "features", "chat", "ChatMessage.tsx");
  assert.match(src, /copyText\(msg\.message\); closeBar\(\)/, "no copy button on the row toolbar");
  assert.doesNotMatch(src, /onPin\(msg\); closeBar\(\)/, "the pin button is back on the toolbar");
  assert.doesNotMatch(src, /confirmDelete/,
    "a delete control is back on the toolbar — its two-step arm is invisible on touch (title-only)");
  // ⋯ opens a menu of mod actions plus Report, so it renders only when there is
  // at least one — a viewer who cannot report gets the toolbar without it.
  assert.match(src, /\{\(onPin \|\| onModDelete \|\| canReport\) && msg\.id != null && \(/,
    "the ⋯ is not gated to what it holds — a viewer gets a button that opens an empty menu");
  const menu = read("app", "components", "MessageContextMenu.tsx");
  for (const gone of ["onReply", "onVote", "onCopy", "myVote"])
    assert.doesNotMatch(menu, new RegExp(`\\b${gone}\\b`),
      `MessageContextMenu still duplicates ${gone} from the toolbar that is necessarily open to reach it`);
  assert.match(menu, /confirmDelete/, "the menu delete lost its two-step arm");
  assert.match(menu, /Confirm delete\?/, "the armed state no longer changes the visible label");
});

test("3: the emote picker tracks its anchor per-frame — keyboard moves cannot strand it", () => {
  // The composer settles after keyboard open/close on the lifted panel's OWN
  // transform transition (useKeyboardLift), which finishes with NO viewport
  // event — exactly the gap ComposerPopover's `track` exists for (see its long
  // note). A picker that does not pass it sits wherever the last event left
  // it: mid-screen, detached from the composer.
  const src = read("app", "components", "EmotePicker.tsx");
  const at = src.indexOf("<ComposerPopover");
  assert.notEqual(at, -1, "vacuity anchor: EmotePicker no longer renders ComposerPopover");
  const tag = src.slice(at, src.indexOf(">", at));
  assert.match(tag, /\btrack\b/,
    "the picker's popover does not track its anchor — a keyboard geometry change strands it mid-screen");
});
