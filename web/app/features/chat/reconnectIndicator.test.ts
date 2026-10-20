// A dropped chat socket must be VISIBLE.
//
// If `connected` were consumed only by the zero-messages empty state, then once
// any message had rendered a WS drop would render NOTHING anywhere: the feed
// silently freezes, and the viewer reads a quiet chat as a quiet stream (the
// reconnect backoff can sit at 30s between attempts, so "silent" means half a
// minute of dead feed on flaky mobile). onClose flips `connected` false, onOpen
// flips it back; this pins that something paints it.
//
// role="status", not role="alert": the feed itself is a polite live region,
// and a connection blip is context, not an interruption.
//
// Run: node --test app/features/chat/reconnectIndicator.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function readWhole(path: string, tailAnchor: RegExp): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

const SIDEBAR = "app/features/chat/ChatSidebar.tsx";
const SIDEBAR_TAIL = /<\/aside>\s*\)\s*;\s*}\s*$/;

test("a drop with messages on screen paints a reconnecting indicator", () => {
  const src = readWhole(SIDEBAR, SIDEBAR_TAIL);
  const gated = src.match(/\{!connected && messages\.length > 0 &&[\s\S]{0,500}/)?.[0] ?? "";
  assert.ok(gated, "no `!connected && messages.length > 0` branch — once messages exist, " +
    "a socket drop renders nothing and the feed just silently freezes");
  assert.match(gated, /Reconnecting to chat/,
    "the disconnected branch exists but says nothing a viewer can read");
  assert.match(gated, /role="status"/,
    "the reconnect indicator is invisible to screen readers — role=status announces it politely");
});

test("the zero-messages empty state still distinguishes connecting from empty", () => {
  const src = readWhole(SIDEBAR, SIDEBAR_TAIL);
  assert.match(src, /connected \? "No messages yet" : "Connecting to chat…"/,
    "the empty-state connected branch changed — first-load feedback lost");
});

const OVERLAY = "app/features/chat/ChatOverlay.tsx";
const OVERLAY_TAIL = /<\/>\s*\)\s*;\s*}\s*$/;

test("the chat overlay also surfaces a dropped socket", () => {
  // ChatSidebar has had this since the mid-stream-drop fix; the overlay is the
  // same feed on a different surface and was silently exempt. A dead overlay
  // reads exactly like a quiet chat.
  const s = readWhole(OVERLAY, OVERLAY_TAIL);
  assert.match(s, /onOpen:\s*\(\)\s*=>\s*setConn\("up"\)/,
    "the overlay must observe the socket opening and record it in state, not just declare the key");
  assert.match(s, /onClose:[\s\S]{0,80}"down"/,
    "the overlay must observe the socket dropping and record it in state, not just declare the key");
  assert.match(s, /Reconnecting to chat/, "and must say so on screen");
  assert.match(s, /role="status"/, "a blip is context, not an interruption — never role=alert");
});

test("the overlay's reconnect pill is a sibling of the scroller, not inside it", () => {
  // The scroller anchors to its newest message and grows without bound while
  // the stream runs — a pill positioned `absolute` INSIDE it scrolls out of
  // view once the feed overflows, disappearing for exactly the outage it
  // exists to report. Delimiter: `ref={scrollRef}` opens the scroller div, and
  // its own closing `</div>` — found by matching balanced div nesting from
  // there — closes it; anything between must not contain the pill's text.
  const s = readWhole(OVERLAY, OVERLAY_TAIL);
  const openIdx = s.indexOf("ref={scrollRef}");
  assert.notEqual(openIdx, -1, "scrollRef is no longer on a div — this test's delimiter is gone");
  // Walk forward counting div opens/closes, starting at depth 1 for the
  // scroller's own opening tag, until the matching close is found. A
  // self-closing `<div .../>` (the flex-1 spacer) must not shift depth.
  const tagRe = /<div\b[^>]*\/>|<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = openIdx;
  let depth = 1;
  let closeIdx = -1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    const t = m[0];
    if (t.endsWith("/>")) continue; // self-closing div: no depth change
    if (t.startsWith("<div")) depth++;
    else depth--;
    if (depth === 0) { closeIdx = m.index; break; }
  }
  assert.notEqual(closeIdx, -1, "the scroller div's closing tag could not be found — nesting changed");
  const inside = s.slice(openIdx, closeIdx);
  assert.doesNotMatch(inside, /Reconnecting to chat/,
    "the pill is back inside the scroller — it will scroll out of view during the outage it exists for");

  const outside = s.slice(closeIdx);
  // Lazy match to the block's own closing `)}` — NOT a fixed char window: a
  // fixed window is vacuous here, because stripComments deletes the multi-line
  // settings-button docblock right after this block, which pulls the NEXT
  // element's unrelated "fixed top-2 right-2" (the gear button) into range.
  const pill = outside.match(/\{conn === "down"[\s\S]*?\)\}/)?.[0] ?? "";
  assert.ok(pill, "no pill markup found as a sibling of the scroller");
  assert.match(pill, /Reconnecting to chat/, "the sibling block found is not the reconnect pill");
  assert.match(pill, /fixed top-2/, "the pill must be fixed-positioned now that it left the scrolling container");
});

test("the reconnect pill's gate cannot flash on a fresh load — no bare !connected boolean survives", () => {
  // A boolean `connected` starting false can't tell "never opened yet" from
  // "just dropped", so a bare `!connected` gate paints the pill on every load
  // until the first onOpen. The fix removes the boolean entirely in favor of
  // a three-state `conn` ("never" | "up" | "down"), gated on `conn === "down"`.
  const s = readWhole(OVERLAY, OVERLAY_TAIL);
  assert.match(s, /conn === "down" &&/, "the pill must be gated on conn === \"down\"");
  assert.doesNotMatch(s, /\{!connected &&/, "the bare !connected gate is the cold-start flash");
});

const WINDOW = "app/features/chat/ChatWindow.tsx";
const WINDOW_TAIL = /<\/div>\s*\)\s*;\s*}\s*$/;

test("the chat window surfaces a dropped socket too", () => {
  // Same feed, third surface. The window rides useChatMessages, so its signal is
  // the hook's `connected` — gated on having been up once, so a fresh load's
  // DB-fill-before-socket-open race cannot flash the pill (see chatWindow.test).
  const s = readWhole(WINDOW, WINDOW_TAIL);
  assert.match(s, /\{everConnected && !connected &&[\s\S]{0,400}?Reconnecting to chat/);
  assert.match(s, /role="status"/, "a blip is context, not an interruption — never role=alert");
});
