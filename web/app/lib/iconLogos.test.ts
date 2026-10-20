// Icon style = cycling platform logos, each in its own colour, with no box.
// The icon span does not receive cycleClass; instead it stacks one
// PlatformIcon per destination platform, each tinted via platformColorVar and
// crossfaded with opacity-only keyframes (a compositor property — a cycle that
// animates background/color cannot run off the main thread).
//
// Run: node --test app/lib/iconLogos.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => {
  const r = readFileSync(join(process.cwd(), ...p), "utf8");
  assert.ok(r.trimEnd().length > 500);
  return stripComments(r);
};

const ROW = read("app", "features", "chat", "ChatMessage.tsx");
const CSS = read("app", "globals.css");

test("the icon span no longer carries the colour-cycle class (no box behind the logo)", () => {
  assert.doesNotMatch(ROW, /className=\{`chat-pi-icon-el\$\{cycleClass\}`\}/);
});

test("a multi-platform icon stacks one coloured logo per platform", () => {
  assert.match(ROW, /cycleList\.map\(\(p, i\) => \(\s*<span key=\{p\} className="chat-pi-logo"/);
  assert.match(ROW, /color: platformColorVar\(p\)/);
});

test("logos crossfade with opacity only, and every stop is on the compositor", () => {
  for (let n = 2; n <= 5; n++) {
    const kf = CSS.match(new RegExp(`@keyframes chat-pi-logos-${n} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
    assert.ok(kf.length > 0, `missing @keyframes chat-pi-logos-${n}`);
    assert.doesNotMatch(kf, /background|color:/, `chat-pi-logos-${n} animates a paint property`);
  }
});

test("off-screen, animate-multi-platform OFF and reduced motion all hold the first logo", () => {
  assert.match(CSS, /\[data-anim-off\] \.chat-pi-logo \{ animation-play-state: paused !important; \}/);
  assert.match(CSS, /\.chat-pi-nocycle \.chat-pi-logo \{ animation: none; opacity: 0; \}\s*\.chat-pi-nocycle \.chat-pi-logo:first-child \{ opacity: 1; \}/);
});
