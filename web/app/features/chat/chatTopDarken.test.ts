// web/app/features/chat/chatTopDarken.test.ts
// A light darkening at the top of the live message area, so "fade at the top"
// darkens without shadows. The fade is a mask —
// rows turn see-through — which over a light tint or glass shows nothing; the
// darkening gives the edge. Same switch ("Fade chat at the top", in Low power),
// starts below a pinned message, never takes a click, stays under the pin.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/chat/chatTopDarken.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "../../lib/testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = stripCssComments(readFileSync(path.join(here, "..", "..", "globals.css"), "utf8"));
const sidebar = stripComments(readFileSync(path.join(here, "ChatSidebar.tsx"), "utf8"));

test("the darkening follows the fade switch, the pin offset and the fade height", () => {
  const m = css.match(/:root:not\(\.chat-fade-off\) \.chat-msg-area::before \{([^}]*)\}/);
  assert.ok(m, "gated on the fade switch");
  const r = m?.[1] ?? "";
  assert.match(r, /top: var\(--chat-fade-top, 0px\);/);
  assert.match(r, /height: var\(--chat-fade-h, 64px\);/);
  assert.match(r, /background: linear-gradient\(to bottom, rgba\(0, 0, 0, 0\.22\), transparent\);/, "light: the tab bar's seam already darkens the first ~13px");
  assert.match(r, /pointer-events: none;/);
  assert.match(r, /z-index: 1;/, "under the pinned banner (z 10)");
});

test("the pin offset lives on the message area, where both the mask and the darkening read it", () => {
  assert.match(sidebar, /"--chat-fade-top": `\$\{pinHeight\}px`/);
  assert.doesNotMatch(sidebar, /\{ paddingTop: pinHeight, "--chat-fade-top"/, "no longer set on the scroller alone");
  assert.match(sidebar, /pinShown \? \{ "--chat-fade-top": `\$\{pinHeight\}px` \} : null/);
  assert.ok(css.trim().endsWith("}"), "vacuity anchor");
});
