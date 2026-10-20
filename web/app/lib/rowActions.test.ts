// Guards for `.row-actions` — the per-row hover toolbar.
//
// Chat rows and Matrix rows each float a small bar of per-message actions over
// their top-right corner — one control, one implementation. The cost to avoid
// is one that a desktop trace cannot measure:
//
//   • a `.glass` bar carries a `backdrop-filter`;
//   • a bar revealed with `opacity-0` → `opacity-100` rather than `display`
//     stays MOUNTED AND PAINTED at every message in the buffer. Measured on a
//     phone (390x844x3): 79 messages = 79 blur surfaces, all invisible, and the
//     only backdrop-filters on the page — felt as choppiness that went away
//     with shadows off, while a CPU-throttled desktop trace measured every
//     treatment identical to the idle floor.
//
// The invariant these tests defend is not "use this class name". It is: the row
// toolbar is not a blur surface, and it is not painted while it is hidden.
// Both halves regress silently — the markup keeps saying what the author meant.
//
// Run: node --test app/lib/rowActions.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));

// Every component that floats a per-row action bar. A third one belongs here.
const ROW_TOOLBARS = [
  ["app", "features", "chat", "ChatMessage.tsx"],
  ["app", "components", "MatrixMessageRow.tsx"],
];

/** The className string of the `.row-actions` element in a component source. */
function toolbarClasses(path: string[]): string {
  const src = read(...path);
  const cls = src.match(/className="(row-actions[^"]*)"/)?.[1];
  assert.ok(cls, `${path.join("/")} no longer renders a .row-actions element`);
  return cls;
}

test("both row toolbars share ONE definition", () => {
  for (const p of ROW_TOOLBARS) {
    assert.ok(toolbarClasses(p).length > 0);
  }
});

test("the row toolbar is glass through the switch — and only ever one of them", () => {
  // The hover menus match the other pop-ups. That is affordable ONLY because
  // of the display gate (next test): a hidden bar is not painted, so at most
  // the hovered bar blurs. The glass comes from the shared CSS rule, never a
  // per-row `.glass` class, so the gate stays the one place it lives.
  for (const p of ROW_TOOLBARS) {
    assert.doesNotMatch(toolbarClasses(p), /\bglass\b/,
      `${p.join("/")}'s row toolbar carries .glass — the look belongs to .row-actions`);
  }
  const css = read("app", "globals.css");
  const rule = css.match(/^\.row-actions \{([\s\S]*?)\n\}/m)?.[1] ?? "";
  assert.ok(rule.length > 0, "setup: could not find the .row-actions rule");
  assert.match(rule, /background: var\(--glass-bg\)/);
  assert.match(rule, /backdrop-filter: var\(--glass-filter\)/, "through the one glass switch, never a literal blur");
  assert.match(rule, /display: none/, "glass without the display gate is one blur PER MESSAGE");
});

test("the toolbar is NOT PAINTED while hidden", () => {
  // The whole point. `opacity-0` keeps the element mounted, composited and — as
  // glass — blurring. `display: none` is the only reveal that costs nothing at
  // rest.
  const css = read("app", "globals.css");
  const rule = css.match(/^\.row-actions \{([\s\S]*?)\n\}/m)?.[1] ?? "";
  assert.match(rule, /display: none/,
    ".row-actions no longer defaults to display:none — it would paint at every row again");
  assert.match(css, /\.group:hover > \.row-actions \{[\s\S]*?display: flex/,
    "the reveal no longer flips display — check what replaced it actually stops paint");

  for (const p of ROW_TOOLBARS) {
    const cls = toolbarClasses(p);
    assert.doesNotMatch(cls, /\bopacity-0\b/,
      `${p.join("/")}'s toolbar is back to an opacity reveal — mounted and painted at every row`);
    // globals.css is UNLAYERED, so .row-actions beats any of these silently and
    // the markup still reads as if they worked. check-layering gates the
    // collision; this states the intent at the call site.
    assert.doesNotMatch(cls, /\b(hidden|flex|inline-flex|block|grid)\b/,
      `${p.join("/")} sets display next to .row-actions — the class wins, silently`);
    assert.doesNotMatch(cls, /\b(transition|duration|ease|delay)-/,
      `${p.join("/")} sets a transition next to .row-actions — the class wins, silently`);
  }
});

test("the fade survives the display flip, both ways", () => {
  // Without `allow-discrete` the element hits `display: none` on frame one and
  // the exit fade never renders; without @starting-style the entry has no
  // starting opacity to ramp from and it snaps in. Losing either one is
  // invisible in a test that only checks the element hides.
  const css = read("app", "globals.css");
  const rule = css.match(/^\.row-actions \{([\s\S]*?)\n\}/m)?.[1] ?? "";
  assert.match(rule, /transition-property: opacity, display/,
    "display is no longer transitioned — the exit fade is gone");
  assert.match(rule, /transition-behavior: allow-discrete/,
    "allow-discrete is gone — display flips on frame one and the exit fade never renders");
  assert.match(css, /@starting-style \{\s*\.group:hover > \.row-actions \{ opacity: 0; \}/,
    "the @starting-style entry ramp is gone — the bar snaps in");

  // Longhands, not the shorthand: our browserslist still names firefox 100 /
  // safari 15.4, and Lightning CSS may drop a `transition` shorthand carrying
  // `allow-discrete` while lowering it for them. Kept apart, the worst case is
  // a missing fade rather than a missing transition.
  assert.doesNotMatch(rule, /^\s*transition:/m,
    ".row-actions uses the transition shorthand — pack allow-discrete into it and " +
    "Lightning CSS can drop the whole declaration for the old targets in browserslist");
});
