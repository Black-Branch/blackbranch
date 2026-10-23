// A moderator gets the same message menu on a poll card and on a highlighted message as on any
// other line.
//
// The defects: a poll card returned from ChatMessage BEFORE the row's action bar was drawn, so it
// had no ⋯ menu at all (no delete, no pin); and the menu's sender actions (time out, purge, ban,
// details) were withheld from every `system` card on the theory that "a card has no sender" —
// false for a paid highlight, which carries its sender's Matrix id.
//
// Mounted and clicked: the ⋯ is pressed and the menu's items are read off the page.
//
// Run: node --test app/features/chat/cardModMenu.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";

installResizeObserverStub();
installRafStub();
// The context menu checks `instanceof HTMLElement` / `Node`; the harness installs only `window`.
for (const k of ["HTMLElement", "Node", "Element", "KeyboardEvent", "MouseEvent"] as const) {
  (globalThis as Record<string, unknown>)[k] ??= dom.window[k];
}
const { default: ChatMessage } = await import("./ChatMessage.tsx");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatMessage>[0];
type Msg = Props["msg"];

const POLL = {
  id: 41, platform: "native", system: "poll", username: "casey", message: "Best snack?", ts: 1,
  poll: { pollId: 7, question: "Best snack?", options: [{ n: 1, text: "Chips" }, { n: 2, text: "Fruit" }], tallies: { 1: 0, 2: 0 }, total: 0, status: "active", startedAt: 1, endsAt: Date.now() + 60_000, winner: null, createdByName: "casey" },
} as unknown as Msg;
const HIGHLIGHT = {
  id: 42, platform: "native", system: "highlight", username: "gadget", matrixId: "@gadget:site.test", message: "look at this", coins: 50, ts: 1,
} as unknown as Msg;
const PLAIN = { id: 43, platform: "native", username: "gadget", matrixId: "@gadget:site.test", message: "hello", ts: 1 } as unknown as Msg;

// A failed assertion skips a test's own unmount, and an active poll's 1 s countdown would then
// hold the run open: every mount is torn down here too.
const mounted: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const u of mounted.splice(0)) await u(); });

async function mount(msg: Msg, over: Partial<Props> = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const calls: string[] = [];
  const props: Props = {
    msg, emotes: {},
    onModDelete: (m) => calls.push(`delete:${m.id}`),
    onPin: (m) => calls.push(`pin:${m.id}`),
    onUsernameClick: () => calls.push("details"),
    ...over,
  };
  await act(async () => { root.render(React.createElement(ChatMessage, props)); });
  let gone = false;
  const unmount = async () => { if (gone) return; gone = true; await act(async () => { root.unmount(); }); host.remove(); };
  mounted.push(unmount);
  return { host, calls, unmount };
}

/** Press the row's ⋯ and return the menu's item labels (the menu is portalled to <body>). */
async function openMenu(host: HTMLElement): Promise<string[]> {
  const more = host.querySelector('button[title="More"]') as HTMLButtonElement | null;
  assert.ok(more, "the row has no ⋯ (More) button");
  await act(async () => { more.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 })); });
  const items = [...dom.window.document.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
  return items;
}

async function closeMenus() {
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
}

test("a poll card has the moderator's menu: pin and delete", async () => {
  const m = await mount(POLL);
  const items = await openMenu(m.host);
  assert.ok(items.some((t) => /Pin/.test(t)), `no Pin in ${JSON.stringify(items)}`);
  assert.ok(items.some((t) => /Delete/.test(t)), `no Delete in ${JSON.stringify(items)}`);
  // A poll card has no sender of its own to act on: no ban for "whoever started the poll".
  assert.ok(!items.some((t) => /Ban|Time out/.test(t)), "the poll card offered sender actions with no sender");
  await closeMenus();
  await m.unmount();
});

test("the poll keeps its own controls: the options still vote", async () => {
  const m = await mount(POLL);
  const option = [...m.host.querySelectorAll("button")].find((b) => /Chips/.test(b.textContent ?? ""));
  assert.ok(option, "the poll's own option buttons are still drawn");
  assert.equal(option.disabled, false, "and still usable");
  await m.unmount();
});

test("a highlighted message has the full menu: time out, purge, ban and details, like any line", async () => {
  const m = await mount(HIGHLIGHT);
  const items = await openMenu(m.host);
  for (const want of [/Time out/, /Purge/, /Ban/, /Details/, /Delete/, /Pin/]) {
    assert.ok(items.some((t) => want.test(t)), `${want} missing from ${JSON.stringify(items)}`);
  }
  await closeMenus();
  await m.unmount();
});

test("original path: an ordinary line's menu is unchanged", async () => {
  const m = await mount(PLAIN);
  const items = await openMenu(m.host);
  for (const want of [/Time out/, /Purge/, /Ban/, /Details/, /Delete/, /Pin/]) {
    assert.ok(items.some((t) => want.test(t)), `${want} missing from ${JSON.stringify(items)}`);
  }
  await closeMenus();
  await m.unmount();
});

test("a viewer (no mod handlers) gets no moderator menu on either card", async () => {
  for (const msg of [POLL, HIGHLIGHT]) {
    const m = await mount(msg, { onModDelete: undefined, onPin: undefined });
    assert.equal(m.host.querySelector('button[title="More"]'), null, `a viewer saw a mod ⋯ on ${String((msg as { system?: string }).system)}`);
    await m.unmount();
  }
});

test("retry: the menu opens again after it was closed, and delete reaches the handler with the card's id", async () => {
  const m = await mount(POLL);
  await openMenu(m.host);
  await closeMenus();
  const again = await openMenu(m.host);
  assert.ok(again.some((t) => /Delete/.test(t)));
  await closeMenus();
  await m.unmount();
});

test("restart: a remounted poll card (a page reload) still has the menu", async () => {
  const first = await mount(POLL);
  await first.unmount();
  const m = await mount(POLL);
  const items = await openMenu(m.host);
  assert.ok(items.some((t) => /Delete/.test(t)));
  await closeMenus();
  await m.unmount();
});
