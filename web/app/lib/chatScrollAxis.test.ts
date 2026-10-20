// The chat scrollers scroll on ONE axis, and it is the vertical one: a large
// sticker must not let the conversation slide sideways.
//
// Per spec, `overflow-y: auto` with `overflow-x` left at `visible` computes the
// used `overflow-x` to `auto`, so a scroller that declares only the vertical
// axis is a horizontal scroller too — and a hidden scrollbar (`no-scrollbar`)
// hides that until a swipe moves the column.
//
// What overflows: a boosted sticker, `STICKER_BASE_EM × STICKER_MAX_SCALE` em of
// chat font, rendered with `max-width: none` on purpose — a heavily-boosted
// sticker grows past the row's width rather than being squeezed by a cap.
// Oversized emotes take the same override in renderText.
//
// The fix is the container, not the sticker: clipping the container keeps the
// growth and crops it at the column edge instead of dragging the column along.
//
// `clip`, not `hidden`. `hidden` makes the element a scroll container in its
// own right (programmatically scrollable, and a containing block for fixed
// descendants) — which is the thing being removed. `clip` just clips.
//
// Run: node --test app/lib/chatScrollAxis.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));

/** The three elements that own a chat message list and scroll it. */
const SCROLLERS: Array<{ file: string; anchor: string; what: string }> = [
  {
    file: "../features/chat/ChatSidebar.tsx",
    anchor: "chat-scroll-layer",
    what: "the site's chat panel",
  },
  {
    file: "../features/chat/ChatOverlay.tsx",
    anchor: "h-screen w-screen overflow-y-auto",
    what: "the OBS browser-source overlay",
  },
  {
    file: "../features/chat/ChatWindow.tsx",
    anchor: "chat-scroll-layer",
    what: "the chat window (/chat)",
  },
];

test("every chat scroller clips horizontally instead of scrolling sideways", () => {
  for (const { file, anchor, what } of SCROLLERS) {
    const src = read(file);
    const at = src.indexOf(anchor);
    assert.ok(at !== -1, `anchor lost in ${file} — cannot locate ${what}'s scroll container`);
    // The class list is one string literal; read to the end of it rather than a
    // fixed character window, which would silently pass if classes were added.
    const quote = src.lastIndexOf("`", at) !== -1 && src.lastIndexOf("`", at) > src.lastIndexOf('"', at)
      ? "`"
      : '"';
    const end = src.indexOf(quote, at);
    const classes = src.slice(src.lastIndexOf(quote, at) + 1, end === -1 ? at + 200 : end);

    assert.match(classes, /overflow-y-auto/, `${what} no longer scrolls vertically at all`);
    assert.match(
      classes,
      /overflow-x-clip/,
      `${what} has no overflow-x, so it is a HORIZONTAL scroller too — one boosted ` +
      `sticker drags the whole conversation sideways`
    );
    assert.doesNotMatch(
      classes,
      /overflow-x-(auto|scroll|visible)/,
      `${what} explicitly re-enables horizontal scrolling`
    );
  }
});

test("the sticker keeps its uncapped width — the container is what changed", () => {
  // Guards the fix from the other side: capping the sticker instead would
  // remove growth that is intended, and the container clip already stops the
  // sideways scroll.
  const msg = read("../features/chat/ChatMessage.tsx");
  const sticker = msg.slice(msg.indexOf("sticker-grow"));
  assert.match(
    sticker.slice(0, sticker.indexOf("/>")),
    /maxWidth: "none"/,
    "the sticker's width cap is back — the sideways drag must be fixed at the scroll container, " +
    "not by shrinking a sticker someone paid to enlarge"
  );
});
