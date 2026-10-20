// SendToButton RENDERED: the destination MENU (decision 1 — a direct control, never
// a cycle), and the composer binding's face and release.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { SendToButton } = await import("@/app/components/SendToButton");
const { createRoot } = await import("react-dom/client");

function mount(props: Parameters<typeof SendToButton>[0]) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(SendToButton, props)));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const click = (el: Element) => act(() => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const items = () => [...dom.window.document.querySelectorAll('[role="menuitemradio"]')] as HTMLElement[];
const noop = () => {};

test("no binding, nowhere else to send → renders nothing", () => {
  const m = mount({ destCycle: [null], forcedDest: null, onPick: noop, onDisarm: noop });
  assert.equal(m.host.querySelector("button"), null);
  m.unmount();
});

test("a click opens a menu naming every destination; it does not change the destination by itself", () => {
  const picked: (string | null)[] = [];
  const m = mount({ destCycle: [null, "twitch", "kick", "all"], forcedDest: "all", onPick: (d) => picked.push(d), onDisarm: noop });
  const btn = m.host.querySelector("button")!;
  assert.equal(btn.getAttribute("aria-haspopup"), "menu");
  click(btn);
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.deepEqual(items().map((e) => (e.textContent ?? "").replace(/^.* only$/, "only")), ["only", "Twitch", "Kick", "All linked platforms"]);
  assert.deepEqual(items().map((e) => e.getAttribute("aria-checked")), ["false", "false", "false", "true"],
    "the current destination is the checked one");
  assert.deepEqual(picked, [], "opening the menu chose nothing");
  m.unmount();
});

test("picking a destination is the choice — exactly one call, with that destination", () => {
  const picked: (string | null)[] = [];
  const m = mount({ destCycle: [null, "twitch", "all"], forcedDest: "all", onPick: (d) => picked.push(d), onDisarm: noop });
  click(m.host.querySelector("button")!);
  click(items()[0]!);                                   // "<site> only"
  assert.deepEqual(picked, [null], "one deliberate choice, no pass-through values on the way");
  assert.equal(items().length, 0, "and the menu closes");
  m.unmount();
});

test("opening and dismissing the menu (an interrupted choice) chooses nothing", () => {
  const picked: (string | null)[] = [];
  const m = mount({ destCycle: [null, "twitch", "all"], forcedDest: "all", onPick: (d) => picked.push(d), onDisarm: noop });
  const btn = m.host.querySelector("button")!;
  click(btn);
  click(btn);                                           // tap the button again to close
  assert.equal(items().length, 0);
  click(btn);
  act(() => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(items().length, 0, "Escape closes it");
  assert.deepEqual(picked, [], "nothing was picked, so nothing may be stored");
  m.unmount();
});

test("re-picking the current destination is not a new choice", () => {
  const picked: (string | null)[] = [];
  const m = mount({ destCycle: [null, "twitch", "all"], forcedDest: "twitch", onPick: (d) => picked.push(d), onDisarm: noop });
  click(m.host.querySelector("button")!);
  click(items()[1]!);
  assert.deepEqual(picked, []);
  m.unmount();
});

test("while 🔒 is armed the button disarms it and opens no menu", () => {
  let disarmed = 0;
  const m = mount({ destCycle: [null, "twitch", "all"], forcedDest: "encrypted", onPick: noop, onDisarm: () => { disarmed++; } });
  click(m.host.querySelector("button")!);
  assert.equal(disarmed, 1);
  assert.equal(items().length, 0);
  m.unmount();
});

test("a sendTo binding renders the face even with nowhere else to send, and its click releases — not the menu", () => {
  let released = 0; let picked = 0;
  const m = mount({
    destCycle: [null], forcedDest: null, onPick: () => { picked += 1; }, onDisarm: noop,
    binding: { face: { label: "peer", avatarUrl: null }, release: () => { released += 1; } },
  });
  const btn = m.host.querySelector("button")!;
  assert.ok(btn, "the bound control renders");
  assert.equal(btn.getAttribute("aria-label"), "Sending to peer. Click to stop and send to chat again.");
  assert.equal(btn.getAttribute("data-binding"), "sendTo");
  click(btn);
  assert.equal(released, 1, "the click releases the binding");
  assert.equal(picked, 0, "and does NOT change the underlying destination — that falls back untouched");
  assert.equal(items().length, 0);
  m.unmount();
});

test("the face shows the avatar when it has one", () => {
  const m = mount({
    destCycle: [null, "twitch"], forcedDest: null, onPick: noop, onDisarm: noop,
    binding: { face: { label: "peer", avatarUrl: "https://example.test/a.png" }, release: () => {} },
  });
  const img = m.host.querySelector("button img")!;
  assert.ok(img, "an avatar renders inside the control");
  assert.equal(img.getAttribute("alt"), "", "decorative — the label is on the button");
  m.unmount();
});
