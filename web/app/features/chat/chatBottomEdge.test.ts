// web/app/features/chat/chatBottomEdge.test.ts
// The live message area's bottom edge: the same
// separator shade the tab bar casts at the top, mirrored, on the message area
// (not the typing bar), following the separator-shadow switch; and 8px of room
// above the typing bar.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/chat/chatBottomEdge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "../../lib/testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sidebar = stripComments(readFileSync(path.join(here, "ChatSidebar.tsx"), "utf8"));
const globals = stripCssComments(readFileSync(path.join(here, "..", "..", "globals.css"), "utf8"));

test("the message area carries the bottom-edge hook", () => {
  assert.match(sidebar, /className=\{`chat-msg-area relative flex-1 min-h-0 flex flex-col/);
});

test("the shade is the seam shade, mirrored, and never takes a click", () => {
  const m = globals.match(/\.chat-msg-area::after\s*\{([^}]*)\}/);
  assert.ok(m, "rule exists");
  assert.match((m?.[1] ?? ""), /background:\s*var\(--seam-shade\);/, "seam off sets --seam-shade: none → gone");
  assert.match((m?.[1] ?? ""), /height:\s*var\(--seam-shade-h\);/, "depth slider scales it");
  assert.match((m?.[1] ?? ""), /transform:\s*scaleY\(-1\);/, "mirrored: dark at the bottom edge");
  assert.match((m?.[1] ?? ""), /inset:\s*auto 0 0 0;/, "pinned to the bottom");
  assert.match((m?.[1] ?? ""), /pointer-events:\s*none;/, "jump-to-live and the last row stay clickable");
});

test("8px of room above the typing bar; the pin still only sets the top", () => {
  assert.match(sidebar, /chat-scroll-layer flex-1 overflow-y-auto overflow-x-clip overscroll-y-contain pt-1 pb-2 no-scrollbar/);
  assert.match(sidebar, /style=\{pinShown \? \{ paddingTop: pinHeight \} : undefined\}/, "the pin sets only the scroller's TOP padding (its fade offset lives on the area)");
  assert.match(sidebar, /\}\s*$/, "vacuity anchor: ChatSidebar.tsx read to its end");
  assert.ok(globals.trim().endsWith("}"), "vacuity anchor: globals.css read to its end");
});
