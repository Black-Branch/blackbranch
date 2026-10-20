// Guards for the off-screen animation fence + the "Animate name styles"
// toggle. The two per-row INFINITE chat animations — the platform-indicator
// cycle and the token-store username styles — must pause when their row
// leaves the viewport: most running cycles on a full chat page are
// off-screen scrollback.
//
// Run: node --test app/lib/animFence.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

test("the fence marks rows with a DATA-ATTRIBUTE, never a class", () => {
  // React rewrites className wholesale on any row re-render (badge/context
  // changes reach memo'd rows), which would strip an imperative class with no
  // observer callback left to restore it. Attributes React didn't render
  // survive its diff.
  const src = read("app", "lib", "animFence.ts");
  assert.match(src, /setAttribute\("data-anim-off", ""\)/, "the off-screen mark is gone");
  assert.match(src, /removeAttribute\("data-anim-off"\)/, "the on-screen unmark is gone");
  assert.doesNotMatch(src, /classList/,
    "the fence touches classList — React clobbers className on re-render and the " +
    "fence state silently evaporates (see the file's header)");
});

test("ChatMessage fences exactly the rows that animate", () => {
  const src = read("app", "features", "chat", "ChatMessage.tsx");
  assert.match(src, /useAnimFence\(rowRef, cycling \|\| unAnimClass !== ""\)/,
    "the fence no longer covers both infinite animations (indicator cycle + username style)");
});

test("globals.css pauses BOTH animation families for fenced rows, with !important", () => {
  const css = read("app", "globals.css");
  for (const sel of ["chat-pi-cycle-2", "chat-pi-cycle-3", "chat-pi-cycle-4", "chat-pi-cycle-5", "chat-pi-logo", "un-anim"]) {
    assert.match(css, new RegExp(`\\[data-anim-off\\] \\.${sel}`),
      `[data-anim-off] no longer pauses .${sel}`);
  }
  assert.match(css, /\[data-anim-off\] \.un-anim,\s*\[data-anim-off\]\.un-anim \{ animation-play-state: paused !important; \}/,
    "the fence rule lost !important — username-style animations are INLINE " +
    "shorthands (they reset animation-play-state and inline beats the stylesheet)");
});

test("the Animate-name-styles toggle exists end to end", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /unAnim: E\(\{ ls: "chatStyle_unAnim", prePaint: false,/,
    "registry entry gone");
  assert.match(reg, /cls\("un-noanim", !\(v as boolean\)\)/,
    "the effect no longer writes the un-noanim class (class marks the OFF state, like piCycle)");
  assert.match(reg, /unAnim:\s*true,/, "default is no longer on");
  assert.match(read("app", "lib", "settingsMenu.ts"), /s\("unAnim"\)/,
    "the toggle fell out of the settings menu");
  assert.match(read("app", "globals.css"), /\.un-noanim \.un-anim \{ animation: none !important; \}/,
    "the CSS OFF rule is gone — the toggle would do nothing");
});
