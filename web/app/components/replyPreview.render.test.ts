// A reply's quote tells the truth (Discord: the original's first line, a tap jumps to it): the
// real MatrixMessageRow, mounted, with the original in the room, deleted, loading, or not
// available to this viewer.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/components/replyPreview.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

function msg(o: { id: string; body: string; replyTo?: string; redacted?: boolean; sender?: string }) {
  const content = o.redacted ? {} : {
    msgtype: "m.text",
    body: o.replyTo ? `> <@casey:site.test> the original\n\n${o.body}` : o.body,
    ...(o.replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: o.replyTo } } } : {}),
  };
  return {
    getId: () => o.id, getSender: () => o.sender ?? "@casey:site.test", getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 25, 15, 4, 27), isRedacted: () => !!o.redacted,
    getContent: () => content, getOriginalContent: () => content,
    isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
  };
}

function roomWith(inRoom: Record<string, unknown>, fetchRoomEvent: (roomId: string, id: string) => Promise<unknown>) {
  return Object.assign(new EventEmitter(), {
    roomId: "!r:site.test",
    client: Object.assign(new EventEmitter(), { fetchRoomEvent, decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => "@me:site.test" }),
    getMember: (id: string) => ({ userId: id, name: id.slice(1, id.indexOf(":")), rawDisplayName: id.slice(1, id.indexOf(":")), getMxcAvatarUrl: () => null, events: {} }),
    findEventById: (id: string) => inRoom[id] ?? undefined,
    currentState: { maySendRedactionForEvent: () => true },
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getThreads: () => [],
  });
}

// Each fetching test quotes its own id: fetched originals are cached for the page's life.
async function mount(room: unknown, props: Record<string, unknown> = {}, origId = "$orig") {
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const reply = msg({ id: "$reply", body: "my answer", replyTo: origId, sender: "@me:site.test" });
  await act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { ev: reply, room, myUserId: "@me:site.test", onReply: () => {}, ...props }));
  });
  return { el, unmount: () => act(async () => { root.unmount(); el.remove(); }) };
}
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); });
const jumpButton = (el: Element) => el.querySelector('button[aria-label="Jump to the original message"]') as HTMLButtonElement | null;

test("the quote shows the original's text when it is in the room", async () => {
  const room = roomWith({ $orig: msg({ id: "$orig", body: "the first line of the original\nand a second line" }) }, () => Promise.reject(new Error("no fetch expected")));
  const { el, unmount } = await mount(room);
  assert.match(el.textContent ?? "", /the first line of the original/);
  assert.doesNotMatch(el.textContent ?? "", /Loading reply…|Reply to deleted message|isn't available/);
  await unmount();
});

test("an original not loaded yet reads \"Loading reply…\", never \"deleted\"", async () => {
  const room = roomWith({}, () => new Promise(() => {}));
  const { el, unmount } = await mount(room, {}, "$pending");
  assert.match(el.textContent ?? "", /Loading reply…/);
  assert.doesNotMatch(el.textContent ?? "", /Reply to deleted message/);
  await unmount();
});

test("…and its text once the fetch lands (an original further back than the loaded window)", async () => {
  const room = roomWith({}, (_r, id) => Promise.resolve({
    event_id: id, room_id: "!r:site.test", sender: "@casey:site.test", type: "m.room.message", origin_server_ts: 1,
    content: { msgtype: "m.text", body: "message five, fetched" },
  }));
  const { el, unmount } = await mount(room, {}, "$five");
  await settle();
  assert.match(el.textContent ?? "", /message five, fetched/);
  await unmount();
});

test("a deleted original reads \"Reply to deleted message\"", async () => {
  const room = roomWith({ $orig: msg({ id: "$orig", body: "", redacted: true }) }, () => Promise.reject(new Error("no fetch expected")));
  const { el, unmount } = await mount(room);
  assert.match(el.textContent ?? "", /Reply to deleted message/);
  await unmount();
});

test("an original this viewer cannot fetch reads \"Original message isn't available\"", async () => {
  const room = roomWith({}, () => Promise.reject(Object.assign(new Error("Event not found."), { errcode: "M_NOT_FOUND", httpStatus: 404 })));
  const { el, unmount } = await mount(room, {}, "$hidden");
  await settle();
  assert.match(el.textContent ?? "", /Original message isn't available/);
  assert.doesNotMatch(el.textContent ?? "", /Reply to deleted message/);
  await unmount();
});

test("click calls onJumpToReply(id); the name still opens the member card", async () => {
  const room = roomWith({ $orig: msg({ id: "$orig", body: "the original" }) }, () => Promise.reject(new Error("no fetch expected")));
  const jumps: string[] = [];
  const { el, unmount } = await mount(room, { onJumpToReply: (id: string) => jumps.push(id) });
  const btn = jumpButton(el);
  assert.ok(btn, "the quote is a button");
  assert.match(btn.textContent ?? "", /the original/);
  await act(async () => { btn.click(); });
  assert.deepEqual(jumps, ["$orig"]);
  const name = el.querySelector('button[aria-label^="Open member card for"]');
  assert.ok(name, "the quoted name is its own button");
  assert.equal(btn.contains(name), false, "never a button inside a button");
  assert.equal(name.contains(btn), false, "so tapping the name opens the card and never jumps");
  await unmount();
});

test("no handler → no button (the thread panel and the DM window)", async () => {
  const room = roomWith({ $orig: msg({ id: "$orig", body: "the original" }) }, () => Promise.reject(new Error("no fetch expected")));
  const { el, unmount } = await mount(room);
  // a === b, never assert.equal on an element: a failing one inspects the whole DOM.
  assert.ok(jumpButton(el) === null, "no jump button");
  assert.match(el.textContent ?? "", /the original/, "still the quote, as a plain block");
  await unmount();
});

test("a quote of an original waiting for its key repaints when that original decrypts", async () => {
  const state = { failed: true };
  const content = () => (state.failed ? { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" } : { msgtype: "m.text", body: "the original, readable now" });
  const orig = {
    getId: () => "$locked", getRoomId: () => "!r:site.test", getSender: () => "@casey:site.test", getType: () => "m.room.message",
    isRedacted: () => false, getContent: content, isEncrypted: () => true, isDecryptionFailure: () => state.failed,
    get decryptionFailureReason() { return state.failed ? "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" : null; },
  };
  const room = roomWith({ $locked: orig }, () => Promise.reject(new Error("no fetch expected")));
  const { el, unmount } = await mount(room, {}, "$locked");
  assert.match(el.textContent ?? "", /Waiting for this message's key…/, "the quote says the original is waiting");
  state.failed = false;
  await act(async () => { room.client.emit("Event.decrypted", orig); });
  assert.match(el.textContent ?? "", /the original, readable now/, "the memoised row's quote repainted");
  await unmount();
});

// ─── The lock row: a message waiting for its key resolves in place ──────────
test("a waiting row says so, keeps a line's height, and repaints to the text when the key arrives", async () => {
  const state = { failed: true };
  const content = () => (state.failed ? { msgtype: "m.bad.encrypted", body: "** Unable to decrypt: DecryptionError **" } : { msgtype: "m.text", body: "the secret, readable now" });
  const ev = {
    getId: () => "$utd", getSender: () => "@casey:site.test", getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 25, 15, 4, 27), isRedacted: () => false,
    getContent: content, getOriginalContent: content,
    isEncrypted: () => true, isDecryptionFailure: () => state.failed,
    get decryptionFailureReason() { return state.failed ? "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" : null; },
    status: null,
  };
  const room = roomWith({}, () => new Promise(() => {}));
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  const render = (lock: string | undefined) => act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { ev, room, myUserId: "@me:site.test", lock }));
  });
  await render("🔒 Waiting for this message's key…");
  const lock = el.querySelector("[data-lock]") as HTMLElement | null;
  assert.ok(lock, "the lock row is marked");
  assert.match(lock.textContent ?? "", /🔒 Waiting for this message's key…/);
  assert.match(lock.getAttribute("style") ?? "", /min-height: 1lh/, "it holds one line's height, so the text replaces it without a jump");
  assert.doesNotMatch(el.textContent ?? "", /Unable to decrypt/, "never the SDK's raw text");
  // The SDK decrypts the SAME event object in place; the caller's lock copy goes away.
  state.failed = false;
  await render(undefined);
  assert.ok(el.querySelector("[data-lock]") === null, "the lock row is gone");
  assert.match(el.textContent ?? "", /the secret, readable now/, "the memoised row repainted");
  await act(async () => { root.unmount(); el.remove(); });
});
