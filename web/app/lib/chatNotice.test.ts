import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { emitChatNotice, onChatNotice, noticeOnFailure } from "./chatNotice.ts";

// A mod's delete or pin that the server refused must not look like one that
// worked: postJson RESOLVES on a 403 or a 500, so a `.catch(() => {})` never
// even runs. These are the actions that answer.

test("a subscriber hears a notice; an unsubscribed one does not", () => {
  const heard: string[] = [];
  const off = onChatNotice((t) => heard.push(t));
  emitChatNotice("one");
  off();
  emitChatNotice("two");
  assert.deepEqual(heard, ["one"]);
});

test("noticeOnFailure is silent on a 2xx", async () => {
  const heard: string[] = [];
  const off = onChatNotice((t) => heard.push(t));
  await noticeOnFailure(Promise.resolve(new Response(null, { status: 200 })), "Couldn't delete");
  off();
  assert.deepEqual(heard, []);
});

test("a NON-2xx answer is a failure — postJson resolves on those, so a bare catch never saw them", async () => {
  const heard: string[] = [];
  const off = onChatNotice((t) => heard.push(t));
  await noticeOnFailure(Promise.resolve(new Response("Forbidden", { status: 403 })), "Couldn't delete that message.");
  off();
  assert.deepEqual(heard, ["Couldn't delete that message."]);
});

test("a network rejection is the same failure, and never escapes as an unhandled rejection", async () => {
  const heard: string[] = [];
  const off = onChatNotice((t) => heard.push(t));
  await noticeOnFailure(Promise.reject(new Error("offline")), "Couldn't pin that message.");
  off();
  assert.deepEqual(heard, ["Couldn't pin that message."]);
});

// ── wiring ───────────────────────────────────────────────────────────────────
// The helper is only worth anything where it is USED. Each of these was a bare
// `.catch(() => {})`; the composer (site, popout) and the composer-less /chat
// window are the two listeners.
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

test("mod delete, pin and unpin report failure through noticeOnFailure — in the panel AND the /chat window", () => {
  for (const rel of ["../features/chat/ChatSidebar.tsx", "../features/chat/ChatWindow.tsx"]) {
    assert.match(read(rel), /noticeOnFailure\(postJson\("\/api\/mod\/delete"/, rel);
  }
  const pin = read("./useChatPin.ts");
  assert.match(pin, /noticeOnFailure\(postJson\("\/api\/chat\/pin", \{ platform/);
  assert.match(pin, /noticeOnFailure\(postJson\("\/api\/chat\/pin", undefined, "DELETE"\)/);
  assert.doesNotMatch(pin, /postJson\("\/api\/chat\/pin"[^)]*\)\.catch\(\(\) => \{\}\)/);
  assert.match(pin, /dismissPin,?\s*\};\s*\}\s*$/, "scan reached the end of useChatPin");
});

test("every surface LISTENS: the composer, the /chat window that has none, and the column when the composer is absent", () => {
  assert.match(read("../features/chat/ChatInput.tsx"), /useEffect\(\(\) => onChatNotice\(/);
  const hook = read("./useChatNoticeText.ts");
  assert.match(hook, /onChatNotice\(\(t\) => \{\s*setText\(t\);/);
  assert.match(hook, /return text;\s*\}\s*$/, "scan reached the end of useChatNoticeText");
  const win = read("../features/chat/ChatWindow.tsx");
  assert.match(win, /const actionNotice = useChatNoticeText\(\);/);
  assert.match(win, /\{actionNotice && \(/);
  // Signed out or timed out there is no composer, so the column says it itself.
  const side = read("../features/chat/ChatSidebar.tsx");
  assert.match(side, /const noticeText = useChatNoticeText\(\);/);
  assert.match(side, /\{noticeText && !\(isSignedIn && banExpiry === undefined\) && \(/);
});
