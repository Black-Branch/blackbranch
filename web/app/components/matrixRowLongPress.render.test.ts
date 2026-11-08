// Holding a Community message (client polish F9 + F11, ticket #13's rule): ONE sheet opens —
// never the hover toolbar and the sheet together — and holding a reaction pill says who reacted.
// The real MatrixMessageRow, real touch events through React, the real 350 ms timer.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/matrixRowLongPress.render.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { createRoot } = await import("react-dom/client");

const doc = dom.window.document;
const HOLD = 420; // past useLongPress's 350 ms
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const content = { msgtype: "m.text", body: "hold me" };
const ev = {
  getId: () => "$m1", getSender: () => "@casey:site.test", getType: () => "m.room.message",
  getTs: () => Date.UTC(2026, 10, 5, 12, 0, 0), isRedacted: () => false,
  getContent: () => content, getOriginalContent: () => content,
  isEncrypted: () => false, isDecryptionFailure: () => false, status: null,
};
const NAMES: Record<string, string> = { "@casey:site.test": "Casey", "@ann:site.test": "Ann", "@bob:site.test": "Bob" };
const room = {
  roomId: "!r:site.test",
  client: { fetchRoomEvent: () => new Promise(() => {}), decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => "@me:site.test", on: () => {}, off: () => {}, removeListener: () => {} },
  getMember: (id: string) => (NAMES[id] ? { userId: id, name: NAMES[id], rawDisplayName: NAMES[id], getMxcAvatarUrl: () => null, events: {} } : null),
  findEventById: () => undefined,
  currentState: { maySendRedactionForEvent: () => true },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThreads: () => [],
};
const pile = (senders: string[], key = "👍") => ({ key, count: senders.length, mine: null, mxc: null, senders });

// Stable, like Timeline's useCallback'd handlers.
const onReply = () => {};
const onReact = () => {};

beforeEach(() => resetStorage());

async function mountRow(props: Record<string, unknown> = {}) {
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const root = createRoot(host);
  const render = (p: Record<string, unknown>) => act(async () => {
    root.render(React.createElement(MatrixMessageRow as never, { ev, room, myUserId: "@me:site.test", onReply, onReact, ...p }));
  });
  await render(props);
  return { host, render, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

function touch(el: Element, type: "touchstart" | "touchend" | "touchcancel") {
  const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "touches", { value: type === "touchstart" ? [{ clientX: 100, clientY: 200 }] : [] });
  el.dispatchEvent(e);
}
async function hold(el: Element) {
  await act(async () => { touch(el, "touchstart"); });
  await act(async () => { await sleep(HOLD); });
  await act(async () => { touch(el, "touchend"); });
}
// jsdom's selector engine never matches an emoji inside [attr="…"]; compare the attribute instead.
const byAttr = (root: ParentNode, attr: string, value: string) =>
  [...root.querySelectorAll(`[${attr}]`)].find((el) => el.getAttribute(attr) === value) ?? null;
const dialog = () => doc.querySelector('[role="dialog"]');
const text = (r: { host: Element }) => r.host.querySelector(".mx-text.break-words")!;

test("long-press opens the sheet", async () => {
  const r = await mountRow();
  await hold(text(r));
  const s = dialog();
  assert.ok(s, "a sheet opened");
  assert.equal(s!.getAttribute("aria-label"), "Message actions");
  assert.deepEqual([...s!.querySelectorAll("[data-sheet-quick] button")].map((b) => b.getAttribute("aria-label")),
    ["React with 👍", "React with ❤️", "React with 😂", "More reactions"], "a new viewer's quick row is the curated three");
  assert.ok([...s!.querySelectorAll("[data-sheet-item]")].some((b) => b.textContent?.trim() === "Reply"));
  // Never the hover row and the sheet together.
  assert.equal(r.host.querySelector(".row-actions")?.hasAttribute("data-open"), false, "the toolbar did not open too");
  assert.equal(doc.querySelectorAll('[role="dialog"], [role="menu"]').length, 1, "exactly one surface");
  await r.unmount();
});

test("a press the OS takes back (touchcancel) opens nothing", async () => {
  const r = await mountRow();
  await act(async () => { touch(text(r), "touchstart"); });
  await act(async () => { touch(text(r), "touchcancel"); });
  await act(async () => { await sleep(HOLD); });
  assert.equal(dialog(), null, "an edge swipe must not open the sheet");
  await r.unmount();
});

test("retry: close the sheet, hold again, it opens again", async () => {
  const r = await mountRow();
  await hold(text(r));
  const close = dialog()!.querySelector('button[aria-label="Close"], button[title="Close"]');
  assert.ok(close, "the sheet has a close control");
  await act(async () => { close!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(dialog(), null, "closed");
  await hold(text(r));
  assert.ok(dialog(), "the second hold opens it again");
  await r.unmount();
});

test("holding a reaction pill shows who reacted", async () => {
  const r = await mountRow({ reactions: [pile(["@ann:site.test", "@bob:site.test"])] });
  const pill = byAttr(r.host, "data-reaction-key", "👍")!;
  assert.ok(pill, "the pill is there");
  await hold(pill);
  const s = dialog()!;
  assert.equal(s.getAttribute("aria-label"), "Reactions");
  assert.deepEqual([...s.querySelectorAll("[data-reactor]")].map((n) => n.textContent?.trim()), ["Ann", "Bob"]);
  await r.unmount();
});

test("holding inside the open sheet does not re-arm the row underneath", async () => {
  const r = await mountRow({ reactions: [pile(["@ann:site.test"])] });
  await hold(byAttr(r.host, "data-reaction-key", "👍")!);
  assert.equal(dialog()!.getAttribute("aria-label"), "Reactions");
  // The sheet is a portal child of the row: React bubbles its touches to the row.
  await hold(dialog()!.querySelector("[data-reactor]")!);
  assert.equal(dialog()?.getAttribute("aria-label"), "Reactions", "the sheet did not flip to the actions view");
  await r.unmount();
});

test("the pill's title names up to 10 people, then 'and N more'", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `@u${i}:site.test`);
  const r = await mountRow({ reactions: [pile(["@ann:site.test", "@bob:site.test"])] });
  assert.equal(byAttr(r.host, "data-reaction-key", "👍")!.getAttribute("title"), "Ann, Bob");
  await r.render({ reactions: [pile(many)] });
  assert.equal(byAttr(r.host, "data-reaction-key", "👍")!.getAttribute("title"),
    `${many.slice(0, 10).map((id) => id.slice(1, id.indexOf(":"))).join(", ")} and 2 more`);
  await r.unmount();
});

test("the memo row repaints when only the people change", async () => {
  const r = await mountRow({ reactions: [pile(["@ann:site.test"])] });
  // Same key, same count, a different person: rowPropsEqual must compare senders.
  await r.render({ reactions: [pile(["@bob:site.test"])] });
  assert.equal(byAttr(r.host, "data-reaction-key", "👍")!.getAttribute("title"), "Bob");
  await r.unmount();
});

test("the desktop toolbar's quick row is the same ranked three", async () => {
  dom.window.localStorage.setItem("bb_reaction_uses", JSON.stringify([["🔥", 3], ["😮", 1]]));
  const r = await mountRow();
  const quick = [...r.host.querySelectorAll(".row-actions button[title^='React with']")].map((b) => b.getAttribute("title"));
  assert.deepEqual(quick, ["React with 🔥", "React with 😮", "React with 👍"]);
  await r.unmount();
});
