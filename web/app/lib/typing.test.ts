// Discord's typing copy, and the id list a room's members yield for the
// reader (never the reader's own name — the SDK does not strip it from
// `.typing`, so that filtering happens here).
// Run: node --test app/lib/typing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { typingLabel, typingUserIds } from "./typing.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

test("copy by count", () => {
  assert.equal(typingLabel([]), null);
  assert.equal(typingLabel(["Casey"]), "Casey is typing…");
  assert.equal(typingLabel(["Casey", "kid"]), "Casey and kid are typing…");
  assert.equal(typingLabel(["A", "B", "C"]), "A, B, and C are typing…");
  assert.equal(typingLabel(["A", "B", "C", "D"]), "Several people are typing…");
});

test("the reader is never listed; a non-typing member and a duplicate entry are dropped", () => {
  const me = "@kid:site.test";
  const room = (members: Array<{ userId: string; typing: boolean }>) => ({ getMembers: () => members });
  assert.deepEqual(
    typingUserIds(
      room([
        { userId: "@a:site.test", typing: true },
        { userId: me, typing: true },
        { userId: "@a:site.test", typing: true },
        { userId: "@b:site.test", typing: false },
      ]),
      me,
    ),
    ["@a:site.test"],
  );
  assert.deepEqual(typingUserIds(room([]), me), []);
});

test("both composers announce typing; only the main timeline shows it; ignored typists are hidden", () => {
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  const tp = read("app/features/community/ThreadPanel.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /useTypingSender\(\{ client, room, text: input, enabled: !editing \}\)/);
  assert.match(tp, /useTypingSender\(\{ client, room, text: input, enabled: !editing \}\)/);
  assert.match(tl, /useTypingUsers\(\{ client, room, myUserId \}\)/);
  assert.match(tl, /\{typingText && <TypingLine text=\{typingText\} \/>\}/);
  assert.doesNotMatch(tp, /useTypingUsers|TypingLine/, "typing is room-level; the thread panel would show channel typers");
  const hook = read("app/features/community/useTyping.ts", /\}\s*$/);
  assert.match(hook, /isIgnoredUser\(room, id\)/);
  assert.match(hook, /client\.on\(RoomMemberEvent\.Typing, onTyping\)/, "an m.typing event has no room_id — the SDK's re-emitted member event does");
  assert.match(hook, /member\.roomId !== room\.roomId/, "only this room's typing member");
  assert.doesNotMatch(hook, /getRoomId\(\)/, "an m.typing event carries no room_id — never filter on it");
  assert.match(hook, /sendTyping\(roomId, true, TYPING_TIMEOUT_MS\)/);
  assert.match(hook, /sendTyping\(roomId, false, 0\)/);
});
