// Controls that render a visible label must also SAY it.
//
// The Slider must name its range input the way the Toggle beside it names
// itself (role=switch + aria-label): same file, same rows, same bare
// visible-span label — and every ChatSettings row multiplies an unnamed one.
//
// The Modal half: the focus trap counts FOCUSABLE matches, but a matching
// element that is display:none or zero-size is not actually focusable —
// `first.focus()` on one silently no-ops, and the trap's wrap-around breaks in
// whichever direction hit the invisible end. Dialogs here routinely contain
// hidden inputs (file pickers behind styled buttons).
//
// (All Modal call sites pass `label`; the trap filter below is the real
// guard.)
//
// Run: node --test app/lib/namedControls.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("the settings Slider names itself, like the Toggle beside it", () => {
  const src = readWhole("app/components/SettingsControls.tsx",
    /{label}<\/span>\s*{children}\s*<\/div>\s*\)\s*;\s*}\s*$/);
  // The range input, specifically — the visible span is not its name.
  assert.match(src, /type="range"[\s\S]{0,200}aria-label={label}/,
    "the Slider's range input is unnamed — the Toggle names its input, and the " +
    "Slider sat in the same rows unnamed");
});

test("the Window dialog focus trap only counts elements that can actually take focus", () => {
  const src = readWhole("app/components/chrome/Window.tsx", /createPortal\(node, document\.body\);\s*}\s*$/);
  assert.match(src, /getClientRects\(\)\.length > 0/,
    "the trap counts invisible FOCUSABLE matches again — first/last can be a display:none " +
    "element, focus() on it no-ops, and the Tab wrap breaks at whichever end is hidden");
});

test("every window is named — by the type system now", () => {
  // Modal's `label` was optional, so a per-call-site grep policed it. Window
  // makes `name` REQUIRED, which moves the invariant into tsc: this pin only
  // guards the prop's requiredness so a refactor cannot quietly add a `?`.
  const src = readWhole("app/components/chrome/Window.tsx", /createPortal\(node, document\.body\);\s*}\s*$/);
  assert.match(src, /\n  name: string;/,
    "WindowProps.name went optional — an unnamed dialog announces as just \"dialog\"");
  assert.doesNotMatch(src, /name\?\s*:/,
    "WindowProps.name went optional — an unnamed dialog announces as just \"dialog\"");
});
