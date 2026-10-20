// Windows that come down from the TOP of the
// chat — they cover the older messages, while the newest messages and the
// composer stay visible. A choice in Settings › Behavior › Windows ("slide in
// from Bottom / Top", Bottom by default). Same panel, same pane layer; what
// differs is the anchor, the entry /
// exit motion, the room kept free at the bottom, and the gesture: the grabber
// moves the window's BOTTOM edge. A top window must be freely positionable:
// it is SIZED by the drag, stays wherever it is let go, snaps to its own
// size or the full size near either, and closes only when pushed almost shut.
//
// Run: node --test app/lib/chrome/windowFromTop.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act, resetStorage } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";
import { stripComments, stripCssComments } from "../testSource.ts";

installResizeObserverStub();
const { Window } = await import("@/app/components/chrome/Window");
const { topCap, topRelease, MIN_VISIBLE_PX } = await import("./panelGesture.ts");
const { createRoot } = await import("react-dom/client");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the full size is the pane minus the clear strip — the CSS's --top-room, in px", () => {
  assert.equal(topCap(500, 0), 350, "30% of 500 = 150 kept clear");
  assert.equal(topCap(200, 0), 104, "never under 96 kept clear");
  assert.equal(topCap(1000, 0), 760, "never over 240 kept clear");
  assert.equal(topCap(600, 100), 350, "the ceiling is not visible pane");
});

test("a release stays where it is let go; snaps near its own size or the full size; closes only almost shut", () => {
  const at = (h: number, vy = 0, h0 = 300) => topRelease({ h, h0, fitH: 300, capH: 350, vy });
  assert.deepEqual(at(200), { kind: "free", h: 200 }, "smaller, and it STAYS (it must not slide back up)");
  assert.deepEqual(at(310), { kind: "fit" }, "near its own size");
  assert.deepEqual(at(340), { kind: "cap" }, "near the full size");
  assert.deepEqual(at(MIN_VISIBLE_PX - 1), { kind: "dismiss" }, "pushed almost shut");
  assert.deepEqual(at(MIN_VISIBLE_PX + 20), { kind: "free", h: MIN_VISIBLE_PX + 20 });
  assert.deepEqual(at(250, -1.2), { kind: "free", h: 250 }, "a quick size-down is not a close");
  assert.deepEqual(at(120, -1.2), { kind: "dismiss" }, "a hard flick up from well above closes");
  assert.deepEqual(at(200, 1.2), { kind: "cap" }, "a flick down opens it fully");
});

function fixture(from: "top" | null, onClose: () => void = () => {}, kind: "peek" | "task" = "peek") {
  resetStorage();
  if (from) dom.window.localStorage.setItem("chatStyle_winFrom", from);
  _resetWindowLayerForTests();
  // The pane: the chat's scroll box and the window layer, siblings in one body wrapper.
  const pane = dom.window.document.createElement("div");
  const chat = dom.window.document.createElement("div");
  const layer = dom.window.document.createElement("div");
  layer.getBoundingClientRect = () => ({ top: 0, height: 500 } as DOMRect);
  pane.append(chat, layer);
  dom.window.document.body.appendChild(pane);
  registerPaneTarget("live", layer); setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
    React.createElement(Window, { presentation: "panel", kind, name: "bram", onClose, children: React.createElement("div") }),
  ));
  const panel = layer.querySelector('[role="dialog"]') as HTMLElement;
  Object.defineProperty(panel, "offsetHeight", { configurable: true, get: () => parseFloat(panel.style.height) || 300 });
  return { panel, layer, chat, unmount: () => act(() => { root.unmount(); pane.remove(); host.remove(); }) };
}

test("Top task: the chat under it stays live and scrollable, and the window is not modal", () => {
  // A top window leaves the newest messages showing ON PURPOSE, and chat must
  // stay scrollable under it — deadening them defeats it.
  const bottom = fixture(null, () => {}, "task");
  assert.ok(bottom.chat.hasAttribute("inert"), "control: a bottom task window still covers the chat");
  assert.equal(bottom.panel.getAttribute("aria-modal"), "true");
  bottom.unmount();
  const top = fixture("top", () => {}, "task");
  assert.ok(!top.chat.hasAttribute("inert"), "the chat under a top window is live");
  assert.equal(top.panel.getAttribute("aria-modal"), "false", "…and the window is not announced as modal");
  top.unmount();
});

test("Bottom (the default) is today's panel — no top anchor, no foot handle", () => {
  const f = fixture(null);
  assert.equal(f.panel.dataset.from, undefined);
  assert.match(f.panel.className, /rounded-t-xl/);
  assert.equal(f.panel.querySelector(".chrome-window-foot"), null);
  f.unmount();
});

test("Top: anchored at the top, rounded at the bottom, a grabber on its bottom edge", () => {
  const f = fixture("top");
  assert.equal(f.panel.dataset.from, "top");
  assert.match(f.panel.className, /rounded-b-xl/);
  assert.doesNotMatch(f.panel.className, /rounded-t-xl/);
  const foot = f.panel.querySelector(".chrome-window-foot");
  assert.ok(foot, "the handle a thumb reaches, at the edge nearest the newest messages");
  assert.ok(foot!.querySelector(".chrome-window-grabber"));
  assert.equal(f.panel.lastElementChild, foot, "the foot is the panel's last row, under the body");
  f.unmount();
});

test("Top: the grabber sizes the window, and it stays where it is let go", async () => {
  let closed = 0;
  const f = fixture("top", () => { closed++; });
  await sleep(300); // the entry freeze marks the panel entered (backstop)
  const foot = f.panel.querySelector(".chrome-window-foot") as HTMLElement;
  const pointer = (type: string, clientY: number) =>
    act(() => { foot.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, clientX: 100, bubbles: true })); });
  const slowTo = async (y: number) => { await sleep(120); pointer("pointermove", y); pointer("pointerup", y); };
  // Down: taller, never past the full size (500px pane → 350).
  pointer("pointerdown", 300);
  pointer("pointermove", 330);
  assert.equal(f.panel.style.height, "330px", "the bottom edge follows the finger");
  pointer("pointermove", 500);
  assert.equal(f.panel.style.height, "350px", "stops at the clear strip");
  await slowTo(500);
  assert.equal(f.panel.style.height, "350px");
  // Up: smaller, and it STAYS — no close, no spring back.
  pointer("pointerdown", 350);
  pointer("pointermove", 300);
  pointer("pointermove", 200);
  await slowTo(200);
  await sleep(300);
  assert.equal(f.panel.style.height, "200px", "parked where it was let go");
  assert.equal(f.panel.dataset.size, "free");
  assert.equal(closed, 0);
  // Almost shut: closes.
  pointer("pointerdown", 200);
  pointer("pointermove", 100);
  pointer("pointermove", 60);
  await slowTo(60);
  await sleep(300); // exit animation backstop
  assert.equal(closed, 1, "pushed almost shut");
  f.unmount();
});

test("Top: the band is a handle too", async () => {
  const f = fixture("top");
  await sleep(300);
  const grab = f.panel.querySelector(".chrome-window-grab") as HTMLElement;
  const pointer = (type: string, clientY: number) =>
    act(() => { grab.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, clientX: 100, bubbles: true })); });
  pointer("pointerdown", 20);
  pointer("pointermove", 60);
  assert.equal(f.panel.style.height, "340px");
  pointer("pointerup", 60);
  f.unmount();
});

const css = stripCssComments(readFileSync("app/components/chrome/chrome.css", "utf8"));
const gcss = stripCssComments(readFileSync("app/globals.css", "utf8"));
const win = stripComments(readFileSync("app/components/chrome/Window.tsx", "utf8"));

test("Top keeps room at the bottom for the newest messages, a task included", () => {
  const top = /\.chrome-window-panel\[data-from="top"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(top, /top: var\(--pane-ceiling\);/);
  assert.match(top, /bottom: auto;/);
  assert.match(top, /--top-room: clamp\(96px, calc\(\(100% - var\(--pane-ceiling\)\) \* 0\.3\), 240px\);/);
  assert.match(top, /max-height: calc\(100% - var\(--pane-ceiling\) - var\(--top-room\)\);/);
  assert.match(top, /animation-name: panel-drop-in;/);
  // A task opens at half its full size; the pull (topCap, unchanged) still
  // takes it to the full size.
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-kind="task"\] \{ height: calc\(\(100% - var\(--pane-ceiling\) - var\(--top-room\)\) \/ 2\); \}/);
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-closing\] \{ animation-name: panel-drop-out; \}/);
});

test("Top drops in from above and leaves upward, motionless under reduced motion", () => {
  assert.match(gcss, /@keyframes panel-drop-in \{\s*from \{ transform: translateY\(-100%\); \}\s*to\s+\{ transform: translateY\(0\); \}\s*\}/);
  assert.match(gcss, /@keyframes panel-drop-out \{\s*from \{ transform: translateY\(0\); \}\s*to\s+\{ transform: translateY\(-100%\); \}\s*\}/);
  const reduced = gcss.slice(gcss.indexOf("@keyframes panel-seam-in {\n    from { opacity: 0"));
  assert.match(reduced, /@keyframes panel-drop-in \{\s*from \{ opacity: 0; transform: none; \}/, "reduced motion still fires animationend");
  assert.match(reduced, /@keyframes panel-drop-out \{\s*from \{ opacity: 1; transform: none; \}/);
});

test("the keyboard hold and the growth follow are the bottom panel's; a top panel eases its height", () => {
  // The hold pins a BOTTOM-anchored box at the ceiling while it shrinks; a top
  // box is already anchored there. A top box's content change moves its
  // bottom edge, not its top — the height eases (heightTween), both ways.
  assert.match(win, /\} else if \(last > first && panel\.dataset\.from !== "top"\) \{/);
  // Not for a layer-bound box: a TASK window's height is the layer's or
  // the CSS's (chat mode: height: calc(100% - ceiling) with a 200 ms ease), never its content's.
  // Following it would tween every frame of that ease against the ease itself, and the window
  // would size itself very slowly (dozens of tweens over seconds).
  assert.match(win, /if \(panel\.dataset\.from === "top"\) \{\s*if \(panel\.dataset\.kind === "task" \|\| panel\.dataset\.fillable !== undefined\) return;\s*if \(panel\.dataset\.size === undefined && panel\.dataset\.pull === undefined && Math\.abs\(grew\) > 0\.5\) cancelShrinkRef\.current = tweenHeight\(panel, oldH, h\);\s*return;\s*\}/, "a size the user chose is theirs; a task's is the layer's");
});

test("Settings › Behavior › Windows carries both choices, Bottom by default", () => {
  const menu = stripComments(readFileSync("app/lib/settingsMenu.ts", "utf8"));
  assert.match(menu, /\{ title: "Windows", tab: "behavior", items: \[s\("winDock"\), s\("winFrom"\)\] \}/);
  const reg = stripComments(readFileSync("app/lib/settingsRegistry.ts", "utf8"));
  assert.match(reg, /winFrom: E\(\{ ls: "chatStyle_winFrom", prePaint: false, deviceLocal: true, behavior: true,/);
  assert.match(reg, /winFrom:\s+"bottom"/);
});

test("a sliding window wears the pop-up colours, like a floating one", () => {
  // The same three vars .glass uses — the Pop-up colour / see-through / blur
  // settings — never a literal. The full-screen page stays opaque (phone heat).
  const panel = /\n  \.chrome-window-panel \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(panel, /background: var\(--glass-bg\);/);
  assert.match(panel, /backdrop-filter: var\(--glass-filter\);/);
  assert.match(panel, /border: 1px solid var\(--glass-border\);/);
  assert.doesNotMatch(panel, /background: var\(--color-canvas\)/);
  const page = /\.chrome-window-page \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(page, /background: var\(--color-canvas\);/, "the full-screen page stays opaque");
});

test("Top: the bottom handle is a thumb's height — 28px with a wider pill", () => {
  // A thumb's height, so the touch region is easy to slide.
  const foot = /\.chrome-window-foot \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(foot, "vacuity anchor: the foot rule is gone from chrome.css");
  assert.match(foot, /height: 1\.75rem;/);
  assert.match(css, /\.chrome-window-foot > \.chrome-window-grabber \{ top: \.75rem; width: 3rem; \}/);
});

/** A top TASK window whose `fill` can be flipped — the terminal while the chat TUI has it. */
function fillFixture() {
  resetStorage();
  dom.window.localStorage.setItem("chatStyle_winFrom", "top");
  _resetWindowLayerForTests();
  const pane = dom.window.document.createElement("div");
  const chat = dom.window.document.createElement("div");
  const layer = dom.window.document.createElement("div");
  layer.getBoundingClientRect = () => ({ top: 0, height: 500 } as DOMRect);
  pane.append(chat, layer);
  dom.window.document.body.appendChild(pane);
  registerPaneTarget("live", layer); setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const render = (fill: boolean) => act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
    React.createElement(Window, { presentation: "panel", kind: "task", name: "bram", onClose: () => {}, fill, children: React.createElement("div") }),
  ));
  render(false);
  const panel = layer.querySelector('[role="dialog"]') as HTMLElement;
  Object.defineProperty(panel, "offsetHeight", { configurable: true, get: () => parseFloat(panel.style.height) || 300 });
  return { panel, render, unmount: () => act(() => { root.unmount(); pane.remove(); host.remove(); }) };
}

test("filled (the chat TUI has the window): the cap is the whole pane, a pulled size is let go, and the CSS takes it to the bottom", async () => {
  // In chat mode the slide-down window can be pulled all the way down and replaces the typing
  // bar. Outside chat mode the strip stays.
  assert.equal(topCap(500, 0), 350, "control: the usual cap keeps the clear strip");
  assert.equal(topCap(500, 0, true), 500, "filled: the pane");
  assert.equal(topCap(500, 40, true), 460, "…under the keyboard's ceiling");
  const f = fillFixture();
  assert.equal(f.panel.dataset.fillable, "", "a window that CAN fill eases its height (the CSS below)");
  assert.equal(f.panel.dataset.fill, undefined);
  await sleep(300); // entered
  // The user pulled it to 200px and parked it there; then the TUI starts.
  f.panel.style.height = "200px"; f.panel.dataset.size = "free";
  f.render(true);
  assert.equal(f.panel.dataset.fill, "");
  assert.equal(f.panel.style.height, "", "the parked size is let go — the stylesheet's full height takes over");
  assert.equal(f.panel.dataset.size, undefined);
  // Pulling while filled reaches the bottom edge of the pane (500), not the strip (350).
  const foot = f.panel.querySelector(".chrome-window-foot") as HTMLElement;
  const pointer = (type: string, clientY: number) =>
    act(() => { foot.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, clientX: 100, bubbles: true })); });
  pointer("pointerdown", 300);
  pointer("pointermove", 520);
  assert.equal(f.panel.style.height, "500px", "all the way to the bottom");
  pointer("pointerup", 520);
  await sleep(300);
  // Esc in the TUI: back to the usual rules.
  f.render(false);
  assert.equal(f.panel.dataset.fill, undefined);
  assert.equal(f.panel.style.height, "", "a size pulled while filled is let go too");
  f.unmount();
  // The stylesheet: filled, no strip and the full height; and the height eases for a fillable window.
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-fill\] \{ max-height: calc\(100% - var\(--pane-ceiling\)\); \}/);
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-kind="task"\]\[data-fill\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/);
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-fillable\] \{ transition: height var\(--anim-default\) var\(--anim-ease\), translate var\(--anim-default\) var\(--anim-ease\); \}/);
  // The pull reads the same answer: the cap is the pane while the panel is filled.
  // …and while the window owns the phone's keyboard.
  assert.match(stripComments(readFileSync("app/lib/chrome/usePanelPull.ts", "utf8")), /return topCap\(layer\.getBoundingClientRect\(\)\.height, ceiling, panel\?\.dataset\.fill !== undefined \|\| ownsKeyboard\(panel\)\);/);
});

test("the top task you are typing in takes the whole visible pane while the keyboard is up", () => {
  // With the keyboard up, the half rule would give (213 visible − 96 strip) / 2 ≈ 58: a header and a thumb.
  assert.match(css, /html\.kb-open \.chrome-window-panel\[data-from="top"\]\[data-kind="task"\]:focus-within \{ height: calc\(100% - var\(--pane-ceiling\)\); max-height: calc\(100% - var\(--pane-ceiling\)\); \}/);
  // It must come AFTER the half-height rule it overrides (equal-or-higher specificity, later wins).
  assert.ok(css.indexOf("html.kb-open .chrome-window-panel[data-from=\"top\"][data-kind=\"task\"]:focus-within") > css.indexOf(".chrome-window-panel[data-from=\"top\"][data-kind=\"task\"] { height: calc((100%"));
});

test("a fillable top window's height transition stands down during a lift — one layout change, not ten", async () => {
  // The fill rule's `transition: height` must not animate the ceiling jump.
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-fillable\]\[data-lift-follow\] \{ transition: translate var\(--anim-default\) var\(--anim-ease\); \}/);
  const { KB_LIFT_EVENT } = await import("../useViewportHeightVar.ts");
  const f = fillFixture();
  await sleep(300);
  const lift = (phase: string) => act(() => { f.panel.parentElement!.parentElement!.dispatchEvent(new dom.window.CustomEvent(KB_LIFT_EVENT, { bubbles: true, detail: { phase, k: 310 } })); });
  lift("before");
  assert.equal(f.panel.dataset.liftFollow, "", "marked from the lift's before — so the write lands with no height transition");
  lift("after");
  await sleep(300);
  assert.equal(f.panel.dataset.liftFollow, undefined, "…and let go once the follow is done (backstop)");
  f.unmount();
});
