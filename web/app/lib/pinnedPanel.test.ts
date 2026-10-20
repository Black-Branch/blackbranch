// The pinned-messages panel and the jump it makes: an event may be older than
// the loaded window, so the jump pages back (bounded), pauses the scroll
// engine, and scrolls the row into view by its data-event-id.
// Run: node --test app/lib/pinnedPanel.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

test("the scroll engine can be paused programmatically; the live-chat consumer is untouched", () => {
  const hook = read("app/lib/useAnchoredChat.ts", /onScroll,\s*pause,\s*\};\s*}\s*$/);
  assert.match(hook, /const pause = useCallback\(\(\) => setAnchored\(false\), \[setAnchored\]\);/);
});

test("rows are addressable and can be highlighted", () => {
  const row = read("app/components/MatrixMessageRow.tsx", /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  assert.match(row, /data-event-id=\{ev\.getId\(\)\}/);
  // Highlighted wins over both the row's own hover state and the mention wash,
  // since the cascade can only keep one background. The mention wash lives in
  // globals.css (.chat-row-mention-mx, unlayered — so it beats the row's
  // layered hover by itself) and steps aside for a highlighted row via
  // data-hl; a mentioned row keeps its amber wash on hover.
  assert.match(row, /highlighted \? "bg-accent\/15 hover:bg-accent\/15" : ""/, "the highlight must win over the row's own hover state");
  assert.match(row, /data-hl=\{highlighted \? "" : undefined\}/, "the mention wash cannot tell a highlighted row");
  assert.match(row, /a\.highlighted !== b\.highlighted/);
});

test("the timeline mounts the panel, pages back at most JUMP_MAX_PAGES, pauses, then scrolls to the row", () => {
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /const JUMP_MAX_PAGES = 8;/);
  assert.match(tl, /while \(!room\.findEventById\(id\) && pages < JUMP_MAX_PAGES\)/);
  assert.match(tl, /await client\.scrollback\(room, PAGE\);/);
  assert.match(tl, /setLimit\(\(l\) => Math\.max\(l, needed\)\);\s*pause\(\);\s*setHighlightId\(id\);/);
  assert.match(tl, /querySelector\(`\[data-event-id="\$\{CSS\.escape\(highlightId\)\}"\]`\)/);
  assert.match(tl, /scrollIntoView\(\{ block: "center" \}\)/);
  // A repeat jump to the SAME pin, after the highlight already cleared, must
  // scroll again — the once-per-jump guard is reset together with the clear.
  assert.match(tl, /scrolledToRef\.current = null;\s*setHighlightId\(null\);/);
  assert.match(tl, /<PinnedMessages client=\{client\} room=\{room\} ids=\{pinnedIds\} canPin=\{mayPin\} onJump=\{jumpToEvent\} onUnpin=\{unpinId\} open=\{pinsOpen\} onClose=\{closePins\} \/>/);
  // The trigger is the mono pin icon in the room's top bar, right before the
  // threads button — not a pill over the timeline.
  assert.match(tl, /aria-label=\{`\$\{pinnedIds\.length\} pinned messages`\}/);
  assert.match(tl, /aria-expanded=\{pinsOpen\}/);
  assert.match(tl, /<PushPin size=\{15\} weight="bold" \/>/);
  assert.ok(tl.indexOf("<PushPin") < tl.indexOf("<Chats"), "the pin button sits before the threads button");
  assert.doesNotMatch(tl, /📌/);
  assert.match(tl, /highlighted=\{highlightId === ev\.getId\(\)\}/);
});

test("the panel resolves unloaded pins by fetch + decrypt, newest pin first, and never sets state in an effect body", () => {
  const panel = read("app/features/community/PinnedMessages.tsx", /\}\s*$/);
  assert.match(panel, /client\.fetchRoomEvent\(room\.roomId, id\)/);
  assert.match(panel, /client\.decryptEventIfNeeded\(ev\)/);
  assert.match(panel, /\[\.\.\.ids\]\.reverse\(\)/);
  assert.match(panel, /if \(!open\) return null;/, "the panel renders only when the header button opened it");
  assert.doesNotMatch(panel, /📌|aria-expanded/, "the trigger lives in the header, not here");
  assert.match(panel, /No pinned messages yet\./);
  assert.match(panel, /That message is deleted or too far back to jump to\./);
  assert.match(panel, /🔒 Message unavailable/);
  assert.match(panel, /Deleted message/);
});
