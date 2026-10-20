// Identity stability of the chat directory — RENDERED, not source-scanned.
//
// The failure this prevents: `messages` gets a new array identity on every WS
// flush, so a directory rebuilt per flush hands every mounted ChatMessage a
// fresh `directory` prop. ChatMessage is memo()d and every OTHER prop holds
// identity — this one prop failing the shallow compare re-renders and
// re-tokenizes (renderText) all 80–1000 mounted rows per incoming message, on
// phones AND on the OBS overlay. A render sees what a scan cannot: whether the
// OBJECT the rows receive actually changed.
//
// The counterweight: `mentionCandidates` ranking is recency-ordered, and
// recency flips on nearly every message in a two-speaker chat — so the
// candidates must stay FRESH while the row-facing directory keeps identity.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook, React } from "./testDom.ts";
import { useChatDirectory } from "./useChatDirectory.ts";
import type { ChatMsg } from "./chatMsg.ts";

const msg = (o: Partial<ChatMsg>): ChatMsg =>
  ({ id: "1", platform: "native", username: "someone", message: "", ts: 1, ...o }) as ChatMsg;

/** Mount the hook behind a state cell so tests can flush new message arrays. */
async function mounted(initial: ChatMsg[]) {
  return mountHook(() => {
    const [messages, setMessages] = React.useState<ChatMsg[]>(initial);
    return { ...useChatDirectory(messages), setMessages };
  });
}

test("a flush that changes no person keeps the directory OBJECT identity", async () => {
  const h = await mounted([msg({ id: "1", username: "alice", matrixId: "@alice:site.test", ts: 1 })]);
  const before = h.current.directory;
  // Same speaker again: new array identity, identical people.
  await h.act(() => h.current.setMessages((prev) => [
    ...prev, msg({ id: "2", username: "alice", matrixId: "@alice:site.test", ts: 2 }),
  ]));
  assert.equal(h.current.directory, before, "no person changed — rows must be able to bail out");
  await h.unmount();
});

test("a NEW speaker mints a new directory that resolves them", async () => {
  const h = await mounted([msg({ id: "1", username: "alice", matrixId: "@alice:site.test", ts: 1 })]);
  const before = h.current.directory;
  await h.act(() => h.current.setMessages((prev) => [
    ...prev, msg({ id: "2", username: "bob", matrixId: "@bob:site.test", ts: 2 }),
  ]));
  assert.notEqual(h.current.directory, before, "a new person must reach the rows");
  assert.equal(h.current.directory.byKey.get("bob")?.name, "bob");
  await h.unmount();
});

test("an existing speaker changing colour mints a new directory", async () => {
  // Rows render @mentions in the mentioned person's colour — a kept identity
  // here would freeze the old colour on screen.
  const h = await mounted([
    msg({ id: "1", username: "alice", matrixId: "@alice:site.test", ts: 1, usernameColor: "#ff4444" }),
  ]);
  const before = h.current.directory;
  await h.act(() => h.current.setMessages((prev) => [
    ...prev, msg({ id: "2", username: "alice", matrixId: "@alice:site.test", ts: 2, usernameColor: "#44ff44" }),
  ]));
  assert.notEqual(h.current.directory, before, "a colour change must repaint mentions");
  await h.unmount();
});

test("mentionCandidates keep exact recency order even while the directory is kept", async () => {
  const h = await mounted([
    msg({ id: "1", username: "alice", matrixId: "@alice:site.test", ts: 1 }),
    msg({ id: "2", username: "bob", matrixId: "@bob:site.test", ts: 2 }),
  ]);
  const before = h.current.directory;
  assert.deepEqual(h.current.mentionCandidates.map((p) => p.name), ["bob", "alice"]);
  // alice speaks again: ranking must flip to her, rows must NOT re-render.
  await h.act(() => h.current.setMessages((prev) => [
    ...prev, msg({ id: "3", username: "alice", matrixId: "@alice:site.test", ts: 3 }),
  ]));
  assert.deepEqual(h.current.mentionCandidates.map((p) => p.name), ["alice", "bob"],
    "the typeahead ranking is recency — it must never go stale");
  assert.equal(h.current.directory, before,
    "same people, same colours: a ranking flip is invisible to rows");
  await h.unmount();
});
