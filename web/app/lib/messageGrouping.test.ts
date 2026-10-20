// Discord-style grouping shared by the timeline and the thread panel (the
// panel used to carry an inline copy), plus the day boundary both use for
// the date divider. Run: node --test app/lib/messageGrouping.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatrixEvent } from "matrix-js-sdk";
import { stripComments } from "./testSource.ts";
import { isContinuation, startsNewDay } from "./messageGrouping.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

// GROUP_WINDOW_MS is module-private in messageGrouping.ts (check-orphans
// excludes same-file callers from the reference count, so an exported
// constant used only by isContinuation in the same file would still read as
// dead) — recomputed here rather than imported.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

function ev(sender: string, ts: number, reply = false): MatrixEvent {
  return {
    getSender: () => sender,
    getTs: () => ts,
    getContent: () => (reply ? { "m.relates_to": { "m.in_reply_to": { event_id: "$x" } } } : {}),
  } as unknown as MatrixEvent;
}

const noon = new Date(2026, 8, 13, 12, 0, 0).getTime(); // local time on purpose

test("startsNewDay follows the local calendar day (sameDay is private — exercised here)", () => {
  assert.equal(startsNewDay(ev("@a:x", noon), ev("@a:x", noon + 11 * 3600_000)), false);
  assert.equal(
    startsNewDay(
      ev("@a:x", new Date(2026, 8, 13, 23, 59).getTime()),
      ev("@a:x", new Date(2026, 8, 14, 0, 1).getTime())
    ),
    true
  );
  assert.equal(
    startsNewDay(ev("@a:x", new Date(2026, 2, 8, 1).getTime()), ev("@a:x", new Date(2026, 2, 8, 23).getTime())),
    false,
    "a DST switch day is still one day"
  );
});

test("a group breaks on sender, window, reply and day", () => {
  const a = ev("@a:x", noon);
  assert.equal(isContinuation(undefined, a), false);
  assert.equal(isContinuation(a, ev("@a:x", noon + GROUP_WINDOW_MS)), true);
  assert.equal(isContinuation(a, ev("@a:x", noon + GROUP_WINDOW_MS + 1)), false);
  assert.equal(isContinuation(a, ev("@b:x", noon + 1)), false);
  assert.equal(isContinuation(a, ev("@a:x", noon + 1, true)), false);
  const late = ev("@a:x", new Date(2026, 8, 13, 23, 59).getTime());
  assert.equal(isContinuation(late, ev("@a:x", new Date(2026, 8, 14, 0, 1).getTime())), false, "midnight starts a new group");
});

test("the first row and every day change get a divider", () => {
  const a = ev("@a:x", noon);
  assert.equal(startsNewDay(undefined, a), true);
  assert.equal(startsNewDay(a, ev("@b:x", noon + 1)), false);
  assert.equal(startsNewDay(a, ev("@b:x", noon + 24 * 3600_000)), true);
});

test("both panels use the shared rule and render the divider", () => {
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  const tp = read("app/features/community/ThreadPanel.tsx", /<\/div>\s*\);\s*}\s*$/);
  for (const [name, src] of [["Timeline", tl], ["ThreadPanel", tp]] as const) {
    assert.match(src, /import \{[^}]*isContinuation[^}]*\} from "@\/app\/lib\/messageGrouping"/, `${name} imports the shared rule`);
    assert.doesNotMatch(src, /function isContinuation|5 \* 60 \* 1000/, `${name} carries no private copy`);
  }
  assert.match(tl, /\{startsNewDay\(prev, ev\) && <DayDivider ts=\{ev\.getTs\(\)\} \/>\}/, "Timeline renders the divider");
  // ⑥: grouping is computed once per render (the bubbles layout also needs each group's END).
  assert.match(tl, /const grouped = rendered\.map\(\(ev, i\) => isContinuation\(rendered\[i - 1\], ev\) && i !== newIdx\);/, "a row under the New line shows its header");
  assert.match(tl, /grouped=\{grouped\[i\]\}/);
  assert.match(tl, /\{i === newIdx && <NewMessagesLine \/>\}/);
  assert.match(tp, /\{startsNewDay\(i === 0 \? rootEvent : prev, ev\) && <DayDivider ts=\{ev\.getTs\(\)\} \/>\}/, "ThreadPanel's first reply compares to the root, not to a non-existent prev");
  assert.doesNotMatch(tp, /NewMessagesLine/, "the New line is the main timeline's");
});
