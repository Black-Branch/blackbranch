// One predicate for "this sender is on the account's ignore list", applied by
// every list that enumerates timeline events — not the main timeline only: the
// thread panel, the threads list, the forum list and the typing line each
// build their own list, and each must apply it.
// Run: node --test app/lib/ignoredSender.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { isIgnoredSender, isIgnoredUser } from "./ignoredBots.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

const room = { client: { isUserIgnored: (id: string) => id === "@bot:site.test" } };
const ev = (sender: string | undefined) => ({ getSender: () => sender });

test("the predicate reads the room's client", () => {
  assert.equal(isIgnoredUser(room, "@bot:site.test"), true);
  assert.equal(isIgnoredUser(room, "@kid:site.test"), false);
  assert.equal(isIgnoredSender(room, ev("@bot:site.test")), true);
  assert.equal(isIgnoredSender(room, ev("@kid:site.test")), false);
  assert.equal(isIgnoredSender(room, ev(undefined)), false, "a sender-less event is never dropped");
});

test("a room without a client (tests, pre-boot) filters nothing", () => {
  assert.equal(isIgnoredSender({}, ev("@bot:site.test")), false);
  assert.equal(isIgnoredSender({ client: null }, ev("@bot:site.test")), false);
  assert.equal(isIgnoredSender({ client: {} }, ev("@bot:site.test")), false);
});

test("every list applies it: main timeline, thread index, thread roots, forum posts", () => {
  const rows = read("app/lib/timelineRows.ts", /return true;\s*}\s*$/);
  assert.match(rows, /if \(isIgnoredSender\(room, e\)\) return false;/);
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.doesNotMatch(tl, /isUserIgnored\(/, "the timeline goes through the predicate, not the raw client call");
  assert.match(tl, /all\.filter\(\(e\) => isTimelineRow\(room, e, \{ deleted: showDeleted \}\)\)/, "the main timeline shares its renderability rule with the pinned panel's jump");

  const threads = read("app/lib/matrixThreads.ts", /return \{[^}]*rel_type: "m\.thread"[\s\S]*\};\s*}\s*$/);
  assert.match(threads, /function isThreadReplyTo\(room: Room, e: MatrixEvent\)[\s\S]*?if \(isIgnoredSender\(room, e\)\) return null;/, "thread replies (panel, list, chip) drop ignored senders");
  assert.match(threads, /if \(!root \|\| root\.isRedacted\(\) \|\| isIgnoredSender\(room, root\)\) continue;/, "a thread whose root is ignored is not listed");
  assert.equal((threads.match(/isThreadReplyTo\(room, e\)/g) ?? []).length, 2, "index build + per-root scan both pass the room");

  const forum = read("app/lib/matrixForum.ts", /\}\s*$/);
  assert.match(forum, /if \(ev\.isRedacted\(\)\) continue;\s*if \(isIgnoredSender\(room, ev\)\) continue;/, "forum post roots");
});
