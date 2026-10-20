// web/app/lib/ringCycle.test.ts
// The avatar ring cycles the cross-post colours for multi-platform messages.
// Ring mode hides the marker, so without this the ring would show no
// cross-post cue at all. Same gates as the marker: Animate multi-platform / Low
// power (.chat-pi-nocycle), reduced motion, and the off-screen fence.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/ringCycle.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = stripCssComments(readFileSync(path.join(here, "..", "globals.css"), "utf8"));
const row = stripComments(readFileSync(path.join(here, "..", "features", "chat", "ChatMessage.tsx"), "utf8"));

test("the ring colour is a registered custom property the ring reads", () => {
  assert.match(css, /@property --ring-c \{ syntax: "<color>"; inherits: false; initial-value: transparent; \}/);
  const uses = row.match(/boxShadow: "0 0 0 var\(--chat-pfp-ring, 0px\) var\(--ring-c\)"/g) ?? [];
  assert.equal(uses.length, 2, "both the photo and the initial-letter fallback");
  const cls = row.match(/className=\{`chat-pfp-ring-el[^`]*\$\{cycleClass\}`\}/g) ?? [];
  assert.equal(cls.length, 2, "both ring elements carry the row's cycle class");
});

test("the ring animates only in ring mode, with the marker's durations", () => {
  for (const [n, d] of [[2, "1.2s"], [3, "1.8s"], [4, "2.4s"], [5, "3s"]] as const) {
    assert.match(css, new RegExp(`\\.chat-pfp-ring-on \\.chat-pfp-ring-el\\.chat-pi-cycle-${n} \\{ animation: chat-ring-cycle-${n} ${d} linear infinite; \\}`));
    assert.match(css, new RegExp(`@keyframes chat-ring-cycle-${n} \\{`));
  }
  assert.match(css, /\.chat-pfp-ring-el\.chat-pi-cycle-2,[\s\S]{0,200}\{ animation: none; \}/, "outside ring mode the marker's keyframes never paint the avatar");
});

test("every off-switch stops the ring too", () => {
  assert.match(css, /\.chat-pi-nocycle \.chat-pfp-ring-el \{ animation: none !important; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.chat-pfp-ring-el \{ animation: none !important; \}/);
  assert.match(css, /\[data-anim-off\] \.chat-pi-cycle-2,/, "the off-screen pause already matches the cycle class the ring carries");
  assert.ok(css.trim().endsWith("}"), "vacuity anchor");
});
