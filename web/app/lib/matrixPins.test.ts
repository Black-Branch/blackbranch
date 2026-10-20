// Channel pins on m.room.pinned_events — Discord's pins on the Matrix
// primitive Element already shows. Run: node --test app/lib/matrixPins.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { PIN_LIMIT, canPin, pinnedAfterToggle, pinnedEventIds } from "./matrixPins.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

function room(pinned: unknown, may = true) {
  return {
    currentState: {
      getStateEvents: (type: string, key: string) =>
        type === "m.room.pinned_events" && key === "" && pinned !== undefined ? { getContent: () => ({ pinned }) } : null,
      maySendStateEvent: (type: string, userId: string) => type === "m.room.pinned_events" && userId === "@mod:site.test" && may,
    },
  };
}

test("pinned ids: stored order, strings only, deduplicated, empty when unset", () => {
  assert.deepEqual(pinnedEventIds(room(["$a", "$b", 3, "$a", ""])), ["$a", "$b"]);
  assert.deepEqual(pinnedEventIds(room("nope")), []);
  assert.deepEqual(pinnedEventIds(room(undefined)), []);
});

test("who may pin is the room's power-level rule for the state event", () => {
  assert.equal(canPin(room([]), "@mod:site.test"), true);
  assert.equal(canPin(room([]), "@kid:site.test"), false);
  assert.equal(canPin(room([], false), "@mod:site.test"), false);
});

test("toggle appends, removes, ignores a duplicate, and refuses past the limit", () => {
  assert.deepEqual(pinnedAfterToggle(["$a"], "$b", false), ["$a", "$b"]);
  assert.deepEqual(pinnedAfterToggle(["$a", "$b"], "$a", true), ["$b"]);
  assert.deepEqual(pinnedAfterToggle(["$a"], "$a", false), ["$a"]);
  const full = Array.from({ length: PIN_LIMIT }, (_, i) => `$${i}`);
  assert.equal(pinnedAfterToggle(full, "$new", false), null);
  assert.deepEqual(pinnedAfterToggle(full, "$0", true)?.length, PIN_LIMIT - 1);
  assert.equal(PIN_LIMIT, 50);
});

test("the ⋯ menu offers Pin/Unpin from the row, gated in the timeline by canPin and the limit", () => {
  const menu = read("app/components/MsgContextMenu.tsx", /<\/ContextMenu>\s*\);\s*}\s*$/);
  assert.match(menu, /\{onPin && \(\s*<MenuItem onClick=\{\(\) => \{ onPin\(\); onClose\(\); \}\}>\s*<span>📌<\/span> \{pinned \? "Unpin message" : "Pin message"\}/);
  const row = read("app/components/MatrixMessageRow.tsx", /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/);
  assert.match(row, /onPin=\{onTogglePin \? \(\) => onTogglePin\(ev, !!pinned\) : undefined\}\s*pinned=\{pinned\}/);
  assert.match(row, /a\.pinned !== b\.pinned \|\|\s*a\.onTogglePin !== b\.onTogglePin/, "the memo comparator sees the new props");
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /const mayPin = canPin\(room, myUserId\);/);
  assert.match(tl, /pinned=\{pinnedIds\.includes\(ev\.getId\(\) \?\? ""\)\}/);
  assert.match(tl, /onTogglePin=\{mayPin && \(pinnedIds\.includes\(ev\.getId\(\) \?\? ""\) \|\| pinnedIds\.length < PIN_LIMIT\) \? handleTogglePin : undefined\}/);
  const hook = read("app/features/community/usePins.ts", /\}\s*$/);
  assert.match(hook, /room\.on\(RoomStateEvent\.Events, onState\)/);
  assert.match(hook, /ev\.getType\(\) === EventType\.RoomPinnedEvents/);
});
