// ⑥ Community settings — the real MatrixMessageRow, mounted, with the switches
// that change what React renders: a deleted message as a note, "(edited)" with its
// original on a tap, the chat's name style + pronoun mark, the stripe and the group
// marks the layouts key off, the avatar size. And the typing sender, run, with the
// Privacy switch both ways. (The CSS-only switches are pinned in
// communitySettings.test.ts; what they LOOK like is the contact sheet's job.)
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/communityRow.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, mountHook, resetStorage } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { useTypingSender } = await import("../features/community/useTyping.ts");
const { UnreadDot } = await import("../features/community/parts.tsx");
const { createRoot } = await import("react-dom/client");

type Opts = { id?: string; sender?: string; body?: string; redacted?: boolean; edited?: Record<string, unknown> };
function ev(o: Opts = {}) {
  const content = o.redacted ? {} : { msgtype: "m.text", body: o.body ?? "hello world" };
  return {
    getId: () => o.id ?? "$1", getSender: () => o.sender ?? "@casey:site.test", getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 12, 15, 4, 27), isRedacted: () => !!o.redacted,
    // The SDK's getContent() already reads an applied edit; the original is getOriginalContent().
    getContent: () => (o.edited ?? content), getOriginalContent: () => content,
    isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
  };
}
const room = {
  roomId: "!r:site.test",
  getMember: (id: string) => ({ userId: id, name: id.slice(1, id.indexOf(":")), rawDisplayName: id.slice(1, id.indexOf(":")), getMxcAvatarUrl: () => null, events: {} }),
  findEventById: () => null,
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
};

async function mount(props: Record<string, unknown>) {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { room, myUserId: "@me:site.test", onReply: () => {}, onReact: () => {}, ...props }));
  });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}

test("an ordinary row: Community's own marks, today's default look", async () => {
  const { el, unmount } = await mount({ ev: ev() });
  const row = el.querySelector(".mx-row")!;
  assert.ok(row, "the row carries .mx-row");
  assert.equal(row.hasAttribute("data-head"), true, "a head row is marked");
  assert.equal(row.hasAttribute("data-gend"), false);
  assert.equal(row.classList.contains("chat-msg-alt"), false);
  assert.ok(el.querySelector(".mx-avatar"), "the avatar sits in .mx-avatar (Community › Avatars)");
  assert.ok(el.querySelector(".mx-time"), "the time sits in .mx-time (Community › Times)");
  assert.ok(el.querySelector(".chat-badges"), "badges sit in .chat-badges (Chat rows › Badges)");
  assert.ok(el.querySelector(".row-actions"), "the toolbar is there");
  assert.match(el.textContent ?? "", /hello world/);
  await unmount();
});

test("the stripe, the group end and the compact avatar arrive as props", async () => {
  const a = await mount({ ev: ev(), alt: true, groupEnd: true, grouped: true, avatarSize: 12 });
  const row = a.el.querySelector(".mx-row")!;
  assert.equal(row.classList.contains("chat-msg-alt"), true);
  assert.equal(row.hasAttribute("data-gend"), true);
  assert.equal(row.hasAttribute("data-head"), false, "a grouped row has no header");
  await a.unmount();
  const b = await mount({ ev: ev(), avatarSize: 12 });
  const img = b.el.querySelector(".mx-avatar > *") as HTMLElement;
  assert.match(img.getAttribute("style") ?? "", /0\.857 \* var\(--chat-pfp-scale, 1\)/, "12px at the default size, still × Avatar size");
  await b.unmount();
});

test("a deleted message renders as the note alone — no toolbar, reactions or thread chip", async () => {
  const { el, unmount } = await mount({ ev: ev({ redacted: true }), reactions: [{ key: "👍", count: 2, mine: null }], threadCount: 3 });
  assert.match(el.textContent ?? "", /Message deleted/);
  assert.equal(el.querySelector(".row-actions"), null, "no toolbar on a deleted message");
  assert.doesNotMatch(el.textContent ?? "", /👍|3 replies/);
  await unmount();
});

test("\"(edited)\": shown by default, a tap shows the original; off = no tag", async () => {
  const edited = { msgtype: "m.text", body: "fixed text" };
  const on = await mount({ ev: ev({ body: "typo txt", edited }), editedContent: edited });
  assert.match(on.el.textContent ?? "", /fixed text/);
  const tag = [...on.el.querySelectorAll("button")].find((b) => b.textContent === "(edited)");
  assert.ok(tag, "the tag is a button");
  assert.doesNotMatch(on.el.textContent ?? "", /Original:/);
  await act(async () => { tag!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.match(on.el.textContent ?? "", /Original: typo txt/);
  await on.unmount();
  const off = await mount({ ev: ev({ body: "typo txt" }), editedContent: edited, showEdited: false });
  assert.doesNotMatch(off.el.textContent ?? "", /\(edited\)/);
  await off.unmount();
});

test("the chat's name style and pronoun mark reach the Community name", async () => {
  const looks = { "@casey:site.test": { s: { effect: "glow" }, p: "she/her" } };
  const { el, unmount } = await mount({ ev: ev(), looks });
  const styled = el.querySelector(".chat-un-style");
  assert.ok(styled, "the name is in .chat-un-style (Chat rows › Name styles)");
  assert.ok(el.querySelector(".chat-pron"), "the pronoun mark is in .chat-pron (Chat rows › Pronoun symbols)");
  await unmount();
});

test("Community › Reaction size: the pill reads × --mx-react-scale", async () => {
  const { el, unmount } = await mount({ ev: ev(), reactions: [{ key: "👍", count: 2, mine: null }] });
  const pill = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("2") && b.classList.contains("rounded-full"));
  assert.ok(pill, "the reaction pill rendered");
  assert.match(pill?.getAttribute("style") ?? "", /calc\(var\(--text-chat-sm\) \* var\(--mx-react-scale, 1\)\)/);
  await unmount();
});

test("Send typing OFF: no announcement leaves; ON: one does", async () => {
  const sent: Array<[string, boolean]> = [];
  const client = { sendTyping: (id: string, on: boolean) => { sent.push([id, on]); return Promise.resolve({}); } };
  const r = { roomId: "!r:site.test" };
  resetStorage();
  dom.window.localStorage.setItem("chatStyle_mxTyping", "0");
  const off = await mountHook(() => useTypingSender({ client: client as never, room: r as never, text: "hello", enabled: true }));
  await off.unmount();
  assert.deepEqual(sent.filter(([, on]) => on), [], "typing OFF announced anyway");
  dom.window.localStorage.removeItem("chatStyle_mxTyping");
  const on = await mountHook(() => useTypingSender({ client: client as never, room: r as never, text: "hello", enabled: true }));
  await on.unmount();
  assert.deepEqual(sent.filter(([, v]) => v), [["!r:site.test", true]]);
  resetStorage();
});

test("Community › Unread channels › Counts: a number, rose for mentions; dots stay dots", async () => {
  const el = dom.window.document.createElement("div");
  const root = createRoot(el);
  await act(async () => { root.render(React.createElement(UnreadDot, { total: 7, highlight: 0, counts: true })); });
  assert.equal(el.textContent, "7");
  assert.equal(el.firstElementChild?.hasAttribute("data-unread-dot"), true, "blue counts still obey Behavior › Unread dots");
  await act(async () => { root.render(React.createElement(UnreadDot, { total: 7, highlight: 2, counts: true })); });
  assert.equal(el.textContent, "2");
  assert.match(el.firstElementChild?.className ?? "", /bg-rose-500/);
  await act(async () => { root.render(React.createElement(UnreadDot, { total: 150, highlight: 0, counts: true })); });
  assert.equal(el.textContent, "99+");
  await act(async () => { root.render(React.createElement(UnreadDot, { total: 7, highlight: 0 })); });
  assert.equal(el.textContent, "", "dots mode draws no number");
  await act(async () => { root.unmount(); });
});
