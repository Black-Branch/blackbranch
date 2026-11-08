// A row redacted in place repaints as deleted (client polish Task 21). The SDK redacts the SAME
// event object, and the row is memoised on its props, so before this a run of lines deleted by a
// ban kept showing their text until something else re-rendered them (found by look/21 on the
// pair: three lines redacted on the server, one shown as deleted). The list passes `redacted`.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/redactedRowRepaint.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../lib/testDom.ts";
import { stripComments } from "../lib/testSource.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

let redacted = false;
const content = { msgtype: "m.text", body: "a line that goes" };
const ev = {
  getId: () => "$1", getSender: () => "@casey:site.test", getType: () => "m.room.message",
  getTs: () => Date.UTC(2026, 10, 6, 5, 0, 0), isRedacted: () => redacted,
  getContent: () => (redacted ? {} : content), getOriginalContent: () => (redacted ? {} : content),
  isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
};
const room = {
  roomId: "!r:site.test",
  client: { fetchRoomEvent: () => new Promise(() => {}), decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => "@me:site.test", on: () => {}, off: () => {}, removeListener: () => {} },
  getMember: (id: string) => ({ userId: id, name: "casey", rawDisplayName: "casey", getMxcAvatarUrl: () => null, events: {} }),
  findEventById: () => undefined,
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
  on: () => {}, off: () => {}, removeListener: () => {},
};
const onReply = () => {};
const onReact = () => {};

test("redacted in place: the row repaints as deleted when the list says so", async () => {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const render = () => act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { ev, room, myUserId: "@me:site.test", onReply, onReact, redacted: ev.isRedacted() }));
  });
  try {
    await render();
    assert.match(el.textContent ?? "", /a line that goes/);
    redacted = true;
    await render();
    assert.match(el.textContent ?? "", /Message deleted/);
    assert.doesNotMatch(el.textContent ?? "", /a line that goes/);
  } finally {
    await act(async () => { root.unmount(); el.remove(); });
  }
});

test("every list that renders rows passes the redacted state (end-anchored)", () => {
  for (const [file, expr] of [
    ["../features/community/Timeline.tsx", "redacted={rowRedacted(ev)}"],
    ["../features/community/ThreadPanel.tsx", "redacted={rowRedacted(rootEvent)}"],
    ["../features/community/ThreadPanel.tsx", "redacted={rowRedacted(ev)}"],
    ["../features/dm/DmConversation.tsx", "redacted={rowRedacted(ev)}"],
  ] as const) {
    const raw = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(raw, /\}\n?$/, `${file}: the whole file was read`);
    const src = stripComments(raw);
    const rows = src.split("<MatrixMessageRow").length - 1;
    assert.ok(rows > 0, `${file}: renders rows`);
    assert.ok(src.includes(expr), `${file}: ${expr}`);
  }
});
