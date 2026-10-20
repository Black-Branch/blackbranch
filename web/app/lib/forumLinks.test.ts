import { test } from "node:test";
import assert from "node:assert/strict";
import { dom } from "./testDom.ts";
import { OPEN_FORUM_THREAD_EVENT, openForumThread, readThreadDetail } from "./forumLinks.ts";

// dispatchClaimable builds a `new CustomEvent(...)` from the global; jsdom's
// window rejects Node's own CustomEvent class, so the test hands it jsdom's.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = dom.window.CustomEvent;

test("openForumThread is claimable: false with no host, true once a host claims it", () => {
  assert.equal(openForumThread({ roomId: "!r:x", eventId: "$e" }), false);
  const seen: unknown[] = [];
  const onEv = (e: Event) => { seen.push(readThreadDetail(e)); e.preventDefault(); };
  dom.window.addEventListener(OPEN_FORUM_THREAD_EVENT, onEv);
  try {
    assert.equal(openForumThread({ roomId: "!r:x", eventId: "$e" }), true);
    assert.deepEqual(seen, [{ roomId: "!r:x", eventId: "$e" }]);
  } finally { dom.window.removeEventListener(OPEN_FORUM_THREAD_EVENT, onEv); }
});

test("readThreadDetail rejects anything that is not a room id + event id pair", () => {
  const mk = (detail: unknown) => new dom.window.CustomEvent("x", { detail });
  assert.equal(readThreadDetail(mk({ roomId: "r", eventId: "$e" })), null);
  assert.equal(readThreadDetail(mk({ roomId: "!r:x", eventId: "e" })), null);
  assert.equal(readThreadDetail(mk({ roomId: "!r:x" })), null);
  assert.equal(readThreadDetail(mk("nope")), null);
  assert.equal(readThreadDetail(new dom.window.Event("x")), null);
});

// ── Host scans: who claims the deep link, and how ────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { stripComments } from "./testSource.ts";
const readSrc = (rel: string) => stripComments(fs.readFileSync(path.join(process.cwd(), rel), "utf8"));

test("both hosts claim the thread deep link in a LAYOUT effect, each for its own viewport", () => {
  const dock = readSrc("app/components/BottomDock/index.tsx");
  const chat = readSrc("app/features/chat/ChatSidebar.tsx");
  for (const [src, guard] of [[dock, "if (narrowViewportNow()) return;"], [chat, "if (!narrowViewportNow()) return;"]] as const) {
    const at = src.indexOf("window.addEventListener(OPEN_FORUM_THREAD_EVENT, onThread);");
    assert.ok(at > 0, "listener registered");
    const effectAt = src.lastIndexOf("useLayoutEffect(() => {", at);
    const passiveAt = src.lastIndexOf("useEffect(() => {", at);
    assert.ok(effectAt > passiveAt, "the listener lives in a useLayoutEffect, not a passive effect");
    assert.ok(src.includes(guard), `viewport guard: ${guard}`);
    assert.ok(src.includes("claimEvent(e);"), "the host claims the event");
    assert.ok(src.includes("openThread={pendingThread}"), "the pending thread reaches the tab");
  }
  assert.match(dock, /\}\s*$/); assert.match(chat, /\}\s*$/); // END anchors
});
