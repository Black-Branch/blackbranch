// The compact tab bar stays parked while a window is open over the chat pane (#161).
//
// The defect: in desktop compact the chat's top bar is an overlay parked above the pane, revealed
// when the pointer comes within 48px of the pane's top edge. A window open over the pane (the
// terminal, Edit profile) puts its own band, with its buttons on the right, at exactly that edge,
// so reaching for a window button revealed the tab bar on top of it and the click landed on the
// tab bar. The bottom bar already stood down while a window was open (`standDown`); the top bar
// was never told.
//
// Measured, not class-asserted: the pane's box is stubbed and a real pointermove is dispatched
// at the window's top-right buttons.
//
// Run: node --test app/features/chat/tabBarStandDown.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";
import { stripComments } from "../../lib/testSource.ts";

installResizeObserverStub();
const raf = installRafStub();
const { ChatTabBar } = await import("./ChatTabBar.tsx");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof ChatTabBar>[0];
const BASE: Props = {
  compactOverlay: true, compact: true, split: false, setSplitPref: () => {}, tab: "live", setTab: () => {},
  liveUnseen: false, matrixUnseen: false, setMatrixOpened: () => {}, narrow: false,
  contentTabs: [], contentTab: null, setContentTab: () => {}, unarmedTabs: [], onArmTab: () => {},
  onCloseContentTab: () => {}, splitAvailable: false, selectPane: () => {}, mobileHidden: false,
};

// The chat pane: 320px wide at x 1000, its top edge at y 100. A window's band fills the pane's top
// 30px; its close / action buttons sit at the right end of that band.
const PANE = { top: 100, bottom: 900, left: 1000, right: 1320, width: 320, height: 800, x: 1000, y: 100, toJSON() {} };
const WINDOW_BUTTON = { clientX: 1300, clientY: 115 };

async function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const render = (p: Partial<Props>) => act(async () => { root.render(React.createElement(ChatTabBar, { ...BASE, ...p })); });
  await render({});
  const bar = host.querySelector('[data-bar="chat-top"]') as HTMLElement;
  assert.ok(bar, "the chat top bar rendered");
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  Object.defineProperty(host, "getBoundingClientRect", { value: () => PANE, configurable: true });
  const pointAt = (p: { clientX: number; clientY: number }) => act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { ...p, bubbles: true }));
    raf.flush();
  });
  const away = () => pointAt({ clientX: 1100, clientY: 600 });
  return { bar, render, pointAt, away, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("with a window open over the pane, pointing at the window's buttons does not reveal the tab bar over them", async () => {
  const m = await mount();
  await m.render({ standDown: true });
  await m.pointAt(WINDOW_BUTTON);
  assert.equal(m.bar.hasAttribute("data-revealed"), false, "the tab bar slid over the window's top-right buttons");
  await m.unmount();
});

test("original path: with no window open, the same spot reveals the bar as before", async () => {
  const m = await mount();
  await m.render({ standDown: false });
  await m.pointAt(WINDOW_BUTTON);
  assert.equal(m.bar.hasAttribute("data-revealed"), true, "control: 15px from the pane's top edge is in the reveal band");
  await m.unmount();
});

test("retry: the window closes and the reveal comes back; it opens again and the bar stands down again", async () => {
  const m = await mount();
  await m.render({ standDown: true });
  await m.pointAt(WINDOW_BUTTON);
  assert.equal(m.bar.hasAttribute("data-revealed"), false);
  await m.render({ standDown: false });
  await m.away();
  await m.pointAt(WINDOW_BUTTON);
  assert.equal(m.bar.hasAttribute("data-revealed"), true, "closing the window gives the reveal back");
  await m.render({ standDown: true });
  assert.equal(m.bar.hasAttribute("data-revealed"), false, "a window opening while the bar is revealed parks it at once");
  await m.unmount();
});

test("restart: a freshly mounted bar with a window already open starts parked", async () => {
  const first = await mount();
  await first.unmount();
  const m = await mount();
  await m.render({ standDown: true });
  await m.pointAt(WINDOW_BUTTON);
  assert.equal(m.bar.hasAttribute("data-revealed"), false);
  await m.unmount();
});

test("wiring: the chat sidebar tells the top bar what it tells the bottom bar", () => {
  const side = stripComments(readFileSync(new URL("./ChatSidebar.tsx", import.meta.url), "utf8"));
  const at = side.indexOf("<ChatTabBar");
  assert.ok(at > 0, "ChatTabBar is mounted");
  const tag = side.slice(at, side.indexOf("/>", at));
  assert.match(tag, /standDown=\{windowOpen\}/, "the top bar is not told a window is open");
  const bar = stripComments(readFileSync(new URL("./ChatTabBar.tsx", import.meta.url), "utf8"));
  assert.match(bar, /<Bar\s+slot="top"[\s\S]*?standDown=\{standDown\}/, "ChatTabBar passes it to its Bar");
  assert.match(side.trimEnd(), /\n\}$/, "END anchor");
});
