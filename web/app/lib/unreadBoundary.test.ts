// Where the "New" line goes: the reader's read marker id, captured once when
// the room opened; its timestamp is derived at render from the live room so
// the line can appear once history pulls the marked event in.
// Run: node --test app/lib/unreadBoundary.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { firstUnreadIndex, markerTs, unreadMarkerId } from "./unreadBoundary.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

const ME = "@kid:site.test";
function room(opts: { fullyRead?: string; receipt?: string | null; events: Record<string, number> }) {
  return {
    getAccountData: (type: string) =>
      type === "m.fully_read" && opts.fullyRead ? { getContent: () => ({ event_id: opts.fullyRead }) } : undefined,
    getEventReadUpTo: () => opts.receipt ?? null,
    findEventById: (id: string) => (id in opts.events ? { getTs: () => opts.events[id]! } : undefined),
  };
}

test("m.fully_read wins; the receipt is the fallback", () => {
  assert.equal(unreadMarkerId(room({ fullyRead: "$a", receipt: "$b", events: { $a: 10, $b: 20 } }), ME), "$a");
  assert.equal(unreadMarkerId(room({ receipt: "$b", events: { $b: 20 } }), ME), "$b");
  assert.equal(unreadMarkerId(room({ receipt: null, events: {} }), ME), null);
});

test("markerTs reads the marked event's timestamp only once it is loaded", () => {
  const r = room({ fullyRead: "$a", events: { $a: 10 } });
  assert.equal(markerTs(r, "$a"), 10);
  assert.equal(markerTs(r, "$gone"), null, "an old marker beyond the loaded window shows no line rather than a guessed one");
  assert.equal(markerTs(r, null), null, "no marker id, no line");
});

test("the line sits above the first newer message that is not mine", () => {
  const e = (sender: string, ts: number) => ({ getTs: () => ts, getSender: () => sender });
  const list = [e("@a:x", 5), e("@a:x", 10), e(ME, 15), e("@b:x", 20), e("@a:x", 25)];
  assert.equal(firstUnreadIndex(list, 10, ME), 3, "my own message at 15 is skipped");
  assert.equal(firstUnreadIndex(list, 4, ME), 0);
  assert.equal(firstUnreadIndex(list, 25, ME), -1, "nothing unread");
  assert.equal(firstUnreadIndex(list, null, ME), -1, "no marker, no line");
});

test("the timeline captures the marker id once per room open, derives the timestamp each render, and clears it on send", () => {
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /if \(markerKey !== room\.roomId\) \{\s*setMarkerKey\(room\.roomId\);\s*setMarkerId\(unreadMarkerId\(room, myUserId\)\);\s*\}/, "render-time keyed capture, before the receipt hook can move the marker");
  assert.equal((tl.match(/unreadMarkerId\(/g) ?? []).length, 1, "never re-read while the room stays open");
  assert.match(tl, /flushSync\(\(\) => \{[^}]*setMarkerId\(null\);/, "sending clears the line");
  assert.match(tl, /const newIdx = firstUnreadIndex\(rendered, markerTs\(room, markerId\), myUserId\);/);
});
