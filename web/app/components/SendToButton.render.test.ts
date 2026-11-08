// The Send-to menu, mounted: it shows a platform's refusal state beside the
// name ("Kick: followers-only"), and picking a platform — INCLUDING the one
// already selected — retries it.
//
// Run: node --test app/components/SendToButton.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";

// The menu's popover measures itself; jsdom has no ResizeObserver. A no-op one
// leaves it unmeasured (it is the content and the clicks that are under test).
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { SendToButton } = await import("./SendToButton.tsx");
const { createRoot } = await import("react-dom/client");

type Props = Parameters<typeof SendToButton>[0];

function mount(props: Props) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(SendToButton, props)));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const doc = () => dom.window.document;
function openMenu(host: HTMLElement) {
  const btn = host.querySelector("button.chat-sendto-btn") as HTMLButtonElement;
  assert.ok(btn, "the Send-to button rendered");
  act(() => { btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
}
function item(label: RegExp): HTMLButtonElement {
  const found = [...doc().querySelectorAll('[role="menuitemradio"]')].find((b) => label.test(b.textContent ?? ""));
  assert.ok(found, `menu item ${label} rendered (got: ${[...doc().querySelectorAll('[role="menuitemradio"]')].map((b) => b.textContent).join(" | ")})`);
  return found as HTMLButtonElement;
}

test("the menu shows a skipped platform's state beside its name", () => {
  const m = mount({
    destCycle: [null, "twitch", "kick", "all"], forcedDest: "kick",
    onPick: () => {}, onDisarm: () => {}, onRetry: () => {},
    refusals: new Map([["kick", "followers-only"]]),
  });
  openMenu(m.host);
  assert.match(item(/^Kick/).textContent ?? "", /Kick: followers-only/);
  assert.doesNotMatch(item(/^Twitch/).textContent ?? "", /:/, "a platform with no refusal shows no state");
  const btn = m.host.querySelector("button.chat-sendto-btn")!;
  assert.match(btn.getAttribute("title") ?? "", /followers-only/, "the button itself says why Kick is quiet");
  m.unmount();
});

test("re-picking the CURRENT platform retries it (and is otherwise no change)", () => {
  const picks: (string | null)[] = [];
  const retries: (string | null)[] = [];
  const m = mount({
    destCycle: [null, "kick", "all"], forcedDest: "kick",
    onPick: (d) => picks.push(d), onDisarm: () => {}, onRetry: (d) => retries.push(d),
    refusals: new Map([["kick", "followers-only"]]),
  });
  openMenu(m.host);
  act(() => { item(/^Kick/).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(retries, ["kick"]);
  assert.deepEqual(picks, [], "the destination itself does not change");
  m.unmount();
});

test("picking another destination retries it too, and picks it", () => {
  const picks: (string | null)[] = [];
  const retries: (string | null)[] = [];
  const m = mount({
    destCycle: [null, "kick", "all"], forcedDest: null,
    onPick: (d) => picks.push(d), onDisarm: () => {}, onRetry: (d) => retries.push(d),
  });
  openMenu(m.host);
  act(() => { item(/^All/).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(retries, ["all"]);
  assert.deepEqual(picks, ["all"]);
  m.unmount();
});

// ── The help-desk indicator: the bot's picture, or its letter ────────────────────────────────────
// The public bot avatar route answers 404 when the bot account has no picture. The indicator then
// shows the bot's letter in the shared letter circle — never a broken image, also when the 404
// landed before React attached onError. jsdom loads no images: `complete`/`naturalWidth` are
// stubbed on the prototype before the ref attaches (per src, so a real picture can load).
const { SupportButton } = await import("./SendToButton.tsx");
const imgState = new Map<string, { complete: boolean; naturalWidth: number }>();
const imgProto = dom.window.HTMLImageElement.prototype;
Object.defineProperty(imgProto, "complete", { configurable: true, get(this: HTMLImageElement) {
  return imgState.get(this.getAttribute("src") ?? "")?.complete ?? false;
} });
Object.defineProperty(imgProto, "naturalWidth", { configurable: true, get(this: HTMLImageElement) {
  return imgState.get(this.getAttribute("src") ?? "")?.naturalWidth ?? 0;
} });
// useBotName's /api/bot/name: never answers here, so the caller's fallback name ("Help") shows.
(globalThis as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});

function mountSupport() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(SupportButton, { onLeave: () => {} })));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

test("404 bot avatar → letter", () => {
  imgState.set("/api/avatar/public/bot", { complete: true, naturalWidth: 0 });
  const m = mountSupport();
  const btn = m.host.querySelector("button")!;
  assert.ok(btn.querySelector("img") === null, "no broken image");
  const circle = btn.querySelector("[data-letter-circle]") as HTMLElement | null;
  assert.ok(circle, "the shared letter circle renders");
  assert.equal(circle!.textContent, "H", "the bot's letter (its name, or the 'Help' fallback)");
  m.unmount();
});

test("404 bot avatar arriving after mount → letter", () => {
  imgState.set("/api/avatar/public/bot", { complete: false, naturalWidth: 0 });
  const m = mountSupport();
  const img = m.host.querySelector("button img")!;
  assert.ok(img, "the picture is tried first");
  act(() => { img.dispatchEvent(new dom.window.Event("error")); });
  assert.ok(m.host.querySelector("button img") === null);
  assert.equal(m.host.querySelector("[data-letter-circle]")?.textContent, "H");
  m.unmount();
});

test("the bot's picture loads → the picture", () => {
  imgState.set("/api/avatar/public/bot", { complete: true, naturalWidth: 96 });
  const m = mountSupport();
  assert.equal(m.host.querySelector("button img")?.getAttribute("src"), "/api/avatar/public/bot");
  m.unmount();
});
