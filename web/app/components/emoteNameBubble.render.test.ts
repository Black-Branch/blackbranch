// Tickets #159 and #173 (parked P33): a phone has no hover, so an emote's `title` never shows and
// there was no way to see an emote's name. A TAP on an emote now shows its name above it for 2 s.
// A mouse click shows nothing new (desktop keeps the hover title), and an emote that is hidden
// (a spoiler) or that is part of a link/button is left to that control.
//
// The real renderText and MatrixHtml output, and the real EmoteNameBubble listening on the document.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/emoteNameBubble.render.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

installResizeObserverStub();
process.env.INSTALL_VALUES ??= JSON.stringify({ "site.origin": "https://example.tv" });

const { renderText } = await import("../lib/renderText.tsx");
const { MatrixHtml } = await import("./MatrixHtml.tsx");
const { default: EmoteNameBubble } = await import("./EmoteNameBubble.tsx");
const { createRoot } = await import("react-dom/client");

const EMOTES = {
  KEKW: { url: "https://cdn.7tv.app/emote/a/2x.webp", zeroWidth: false, ar: 1 },
  RainTime: { url: "https://cdn.7tv.app/emote/b/2x.webp", zeroWidth: true, ar: 1 },
};

function mount(children: React.ReactNode) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(React.Fragment, null, React.createElement(EmoteNameBubble), children)));
  return { host, unmount() { act(() => root.unmount()); host.remove(); } };
}

const bubble = () => dom.window.document.querySelector("[data-emote-name-bubble]");

/** A finger (or mouse) press then its click, as a phone browser sends them. */
async function tap(el: Element, pointerType: "touch" | "mouse" = "touch", holdMs = 0) {
  await act(async () => {
    const down = new dom.window.MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: pointerType });
    el.dispatchEvent(down);
    if (holdMs) mock.timers.tick(holdMs);
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}
const advance = async (ms: number) => { await act(async () => { mock.timers.tick(ms); }); };

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
test.afterEach(() => mock.timers.reset());

test("emote images carry their name: chat text and Matrix HTML", () => {
  const m = mount(React.createElement("div", null,
    renderText("hi KEKW", EMOTES),
    React.createElement(MatrixHtml, {
      nodes: [{ t: "el", tag: "img", attrs: { src: "mxc://x/y", alt: ":wave:", title: ":wave:", emote: true }, children: [] }],
      truncated: false, emotes: {},
    } as never)));
  const names = [...m.host.querySelectorAll("img")].map((i) => i.getAttribute("data-emote-name"));
  assert.deepEqual(names, ["KEKW", ":wave:"]);
  // Desktop keeps its hover title.
  assert.equal(m.host.querySelector("img")!.getAttribute("title"), "KEKW");
  m.unmount();
});

test("tap on an emote shows its name; gone after 2 s", async () => {
  const m = mount(React.createElement("div", null, renderText("hi KEKW", EMOTES)));
  await tap(m.host.querySelector('img[data-emote-name="KEKW"]')!);
  assert.equal(bubble()?.textContent, "KEKW");
  await advance(1999);
  assert.ok(bubble(), "still there just before 2 s");
  await advance(1);
  assert.equal(bubble(), null, "gone after 2 s");
  m.unmount();
});

test("a stacked emote names every layer", async () => {
  const m = mount(React.createElement("div", null, renderText("KEKW RainTime", EMOTES)));
  const imgs = m.host.querySelectorAll("img[data-emote-name]");
  assert.equal(imgs.length, 2);
  await tap(imgs[1]!);
  assert.equal(bubble()?.textContent, "KEKW + RainTime");
  m.unmount();
});

test("a mouse click shows nothing (desktop keeps the hover title); a long press shows nothing", async () => {
  const m = mount(React.createElement("div", null, renderText("hi KEKW", EMOTES)));
  const img = m.host.querySelector("img[data-emote-name]")!;
  await tap(img, "mouse");
  assert.equal(bubble(), null);
  await tap(img, "touch", 600);
  assert.equal(bubble(), null, "a long press belongs to the message sheet");
  m.unmount();
});

test("an emote inside a hidden spoiler or a link is left alone", async () => {
  const m = mount(React.createElement("div", null,
    React.createElement("span", { className: "invisible" }, renderText("KEKW", EMOTES)),
    React.createElement("a", { href: "#x" }, renderText("KEKW", EMOTES))));
  for (const img of m.host.querySelectorAll("img[data-emote-name]")) await tap(img);
  assert.equal(bubble(), null);
  m.unmount();
});

test("retry: a second tap restarts the 2 s and replaces the name", async () => {
  const m = mount(React.createElement("div", null, renderText("KEKW", EMOTES), " ", renderText("KEKW", EMOTES)));
  const [a, b] = [...m.host.querySelectorAll("img[data-emote-name]")];
  await tap(a!);
  await advance(1500);
  await tap(b!);
  await advance(1500);
  assert.equal(bubble()?.textContent, "KEKW", "the second tap's 2 s are still running");
  assert.equal(dom.window.document.querySelectorAll("[data-emote-name-bubble]").length, 1, "one bubble, not two");
  await advance(500);
  assert.equal(bubble(), null);
  m.unmount();
});

test("restart: after unmount a tap does nothing, and a fresh mount works again", async () => {
  const first = mount(React.createElement("div", null, renderText("KEKW", EMOTES)));
  const stale = first.host.querySelector("img[data-emote-name]")!;
  first.unmount();
  dom.window.document.body.appendChild(stale);
  await tap(stale);
  assert.equal(bubble(), null, "the old listener is gone");
  stale.remove();
  const second = mount(React.createElement("div", null, renderText("KEKW", EMOTES)));
  await tap(second.host.querySelector("img[data-emote-name]")!);
  assert.equal(bubble()?.textContent, "KEKW");
  second.unmount();
});
