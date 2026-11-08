// #234 (k, 2026-11-06): "slide down pages don't act like slide up pages, they
// have a limit to how far they slide down, etc." A window that slides UP from
// the composer (Settings › Behavior › Windows: Bottom) and one that slides DOWN
// from the top of the chat (Top) are the same window with the anchor flipped,
// so they move by ONE rule: the same travel (the whole visible pane), the same
// release rule (panelGesture.ts releaseTarget / cancelTarget — the top window
// asks it through releaseBySize / cancelBySize, the direction turned around
// once, there), the same easing, and the same hold → flush → release order.
//
// Measured before the fix on the throwaway pair (look/234-slides.mjs): the top
// window stopped short of the composer by the clear strip (96–240px), a quick
// flick up from a parked size only closed it from under half its starting
// size, and a release just above its own size stayed there (a bottom window
// springs back to its own size or on to the full pane).
//
// Run: node --test app/lib/chrome/slideBothWays.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dom, React, act, resetStorage } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";
import { stripComments, stripCssComments } from "../testSource.ts";

installResizeObserverStub();
const { Window } = await import("@/app/components/chrome/Window");
const gesture = await import("./panelGesture.ts");
const { releaseTarget, cancelTarget, MIN_VISIBLE_PX, FLICK_VY } = gesture;
const { createRoot } = await import("react-dom/client");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CAP = 500;

// ── The rule: one function, the direction turned around once ─────────────────

/** What a BOTTOM window shows after releaseTarget, in visible px (null = closed). */
function bottomShows(v: number, vOpen: number, fitV: number): number | null {
  const r = releaseTarget(CAP - v, -vOpen, CAP - Math.min(fitV, CAP), CAP);
  return r.kind === "dismiss" ? null : CAP - r.y;
}
/** What a TOP window shows after releaseBySize, in visible px (null = closed). */
function topShows(v: number, vOpen: number, fitV: number): number | null {
  const r = gesture.releaseBySize(v, vOpen, fitV, CAP);
  if (r.kind === "dismiss") return null;
  return r.kind === "cap" ? CAP : r.kind === "fit" ? Math.min(fitV, CAP) : r.v;
}

test("the same release gives the same answer up and down — every size, speed and own-size", () => {
  let cases = 0;
  for (const fitV of [150, 300, 420, CAP]) {           // CAP = a task: the full pane is its only detent
    for (let v = 0; v <= CAP; v += 10) {
      for (const vOpen of [-1.5, -FLICK_VY - 0.01, -0.2, 0, 0.2, FLICK_VY + 0.01, 1.5]) {
        assert.equal(topShows(v, vOpen, fitV), bottomShows(v, vOpen, fitV), `v=${v} vOpen=${vOpen} fit=${fitV}`);
        cases++;
      }
    }
  }
  assert.equal(cases, 4 * 51 * 7, "vacuity: the whole grid ran");
});

test("a flick toward CLOSED from a parked size closes it in both directions — down for a bottom window, up for a top one", () => {
  assert.equal(bottomShows(200, -1.2, 300), null, "bottom: a flick down (toward closed) from the free range");
  assert.equal(topShows(200, -1.2, 300), null, "top: a flick up (toward closed) from the free range — not only from under half its start");
  assert.equal(topShows(200, 1.2, 300), 300, "top: a flick toward OPEN from the free range goes to its own size, like a bottom window");
  assert.equal(topShows(MIN_VISIBLE_PX - 1, 0, 300), null, "pushed almost shut closes");
  assert.equal(topShows(MIN_VISIBLE_PX + 20, 0, 300), MIN_VISIBLE_PX + 20, "…and just above that it stays");
});

test("the landing is judged at the release only, by the midpoint, the same way up and down", () => {
  // Above its own size (300) and short of the midpoint to the full pane (400): back to its own size.
  assert.equal(topShows(390, 0, 300), 300);
  assert.equal(topShows(410, 0, 300), CAP, "past the midpoint: the full pane");
  assert.equal(topShows(250, 0, 300), 250, "below its own size: parked where it was let go");
  // A flick from the full pane stops at its own size: one gesture is one step.
  assert.equal(topShows(CAP, -1.2, 300), 300);
});

test("a cancel never closes, up or down", () => {
  for (const v of [0, 30, 150, 300, 450, CAP]) {
    const b = cancelTarget(CAP - v, CAP - 300, CAP);
    const t = gesture.cancelBySize(v, 300, CAP);
    assert.notEqual(t.kind, "dismiss", `a cancel at ${v} must not close`);
    const tv = t.kind === "cap" ? CAP : t.kind === "fit" ? 300 : t.kind === "free" ? t.v : NaN;
    assert.equal(tv, CAP - b.y, `cancel at ${v}`);
  }
});

// ── The window itself ─────────────────────────────────────────────────────────

/** A top window in a 500px pane; its own size is 300px (an inline height, or 300). */
function topFixture(opts: { kind?: "peek" | "task"; onClose?: () => void } = {}) {
  resetStorage();
  dom.window.localStorage.setItem("chatStyle_winFrom", "top");
  _resetWindowLayerForTests();
  const pane = dom.window.document.createElement("div");
  const layer = dom.window.document.createElement("div");
  layer.getBoundingClientRect = () => ({ top: 0, height: CAP } as DOMRect);
  pane.append(layer);
  dom.window.document.body.appendChild(pane);
  registerPaneTarget("live", layer); setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const mount = () => act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
    React.createElement(Window, { presentation: "panel", kind: opts.kind ?? "peek", name: "bram", onClose: opts.onClose ?? (() => {}), children: React.createElement("div") }),
  ));
  mount();
  const flushes: string[] = [];
  const wire = () => {
    const panel = layer.querySelector('[role="dialog"]') as HTMLElement;
    Object.defineProperty(panel, "offsetHeight", {
      configurable: true,
      get: () => { flushes.push(`${panel.style.transition}|${panel.style.height}`); return parseFloat(panel.style.height) || (panel.dataset.size === "cap" ? CAP : 300); },
    });
    const foot = panel.querySelector(".chrome-window-foot") as HTMLElement;
    const pointer = (type: string, clientY: number) =>
      act(() => { foot.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, clientX: 100, bubbles: true })); });
    /** Move there and pause, the way a finger about to lift does; the second move is the resting sample. */
    const settleAt = async (y: number) => { pointer("pointermove", y); await sleep(100); pointer("pointermove", y); };
    return { panel, pointer, settleAt };
  };
  return {
    layer, flushes, wire,
    remount: () => { act(() => root.unmount()); return createRoot(host); },
    unmount: () => act(() => { root.unmount(); pane.remove(); host.remove(); }),
    root, mount,
  };
}

test("a top window slides down as far as a bottom window slides up — the whole pane, no strip held back", async () => {
  const f = topFixture();
  const { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300); // entered
    pointer("pointerdown", 300);
    pointer("pointermove", 400);
    assert.equal(panel.style.height, "400px", "the bottom edge follows the finger past the old strip line (350)");
    pointer("pointermove", 900);
    assert.equal(panel.style.height, `${CAP}px`, "it stops at the composer — the whole pane, as a bottom window reaches the top");
    await settleAt(900);
    pointer("pointerup", 900);
    assert.equal(panel.dataset.size, "cap", "released at the full pane, it rests there");
    await sleep(500); // the height tween's backstop
    assert.equal(panel.style.height, "", "…as the stylesheet's full-pane rule, so it follows the keyboard instead of keeping a stale px");
  } finally { f.unmount(); }
});

test("a quick flick up from a parked size closes a top window", async () => {
  let closed = 0;
  const f = topFixture({ onClose: () => { closed++; } });
  const { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300);
    pointer("pointerdown", 300);
    await settleAt(240); // park at 240 — under its own size, well above half of where it started
    pointer("pointerup", 240);
    assert.equal(panel.dataset.size, "free");
    assert.equal(panel.style.height, "240px");
    pointer("pointerdown", 240);
    for (let i = 1; i <= 4; i++) { await sleep(12); pointer("pointermove", 240 - i * 15); }
    pointer("pointerup", 180);
    await sleep(300); // the exit's backstop
    assert.equal(closed, 1, "a flick toward closed from the free range closes, as a flick down closes a bottom window");
  } finally { f.unmount(); }
});

test("a top window let go just above its own size springs back to it", async () => {
  const f = topFixture();
  const { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300);
    pointer("pointerdown", 300);
    await settleAt(380); // 380: above its own size (300), short of the midpoint to the full pane (400)
    pointer("pointerup", 380);
    assert.equal(panel.dataset.size, undefined, "back to its own size (the stylesheet's content fit)");
    assert.equal(panel.style.height, "300px", "…eased there by the height tween");
    await sleep(500);
    assert.equal(panel.style.height, "", "and handed back to the stylesheet");
  } finally { f.unmount(); }
});

test("a parked release flushes the held height BEFORE it hands the transition back", async () => {
  // feedback_a_hold_and_its_release_need_a_flush_between_them: restoring the
  // transition in the same task as the last held write would ease the box from
  // the last RENDERED height (a fillable top window transitions height).
  const f = topFixture();
  const { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300);
    pointer("pointerdown", 300);
    await settleAt(220);
    f.flushes.length = 0;
    pointer("pointerup", 220);
    assert.equal(panel.dataset.size, "free");
    assert.ok(f.flushes.includes("none|220px"), `a layout read with the hold still in force: ${JSON.stringify(f.flushes)}`);
    assert.equal(panel.style.transition, "", "then the transition is the stylesheet's again");
  } finally { f.unmount(); }
});

test("restart: a size pulled by hand does not outlive the window — reopened, it comes back at its own size", async () => {
  const f = topFixture();
  let { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300);
    pointer("pointerdown", 300);
    await settleAt(200);
    pointer("pointerup", 200);
    assert.equal(panel.dataset.size, "free");
    act(() => f.root.unmount());
    const root2 = createRoot(f.layer.ownerDocument.body.lastElementChild as HTMLElement);
    act(() => root2.render(
      // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
      React.createElement(Window, { presentation: "panel", kind: "peek", name: "bram", onClose: () => {}, children: React.createElement("div") }),
    ));
    ({ panel, pointer, settleAt } = f.wire());
    assert.equal(panel.dataset.size, undefined, "a fresh window: no remembered size");
    await sleep(300);
    assert.equal(panel.style.height, "", "its own size, the stylesheet's");
    pointer("pointerdown", 300);
    pointer("pointermove", 900);
    assert.equal(panel.style.height, `${CAP}px`, "and the same travel as the first time");
    pointer("pointerup", 900);
    act(() => root2.unmount());
  } finally { f.unmount(); }
});

test("retry: the second and third gestures on one window get the same rule as the first", async () => {
  let closed = 0;
  const f = topFixture({ kind: "task", onClose: () => { closed++; } });
  const { panel, pointer, settleAt } = f.wire();
  try {
    await sleep(300);
    // A task's only detent is the full pane; everything under it is a position.
    for (const at of [260, 180]) {
      const from = parseFloat(panel.style.height) || 300;
      pointer("pointerdown", from);
      await settleAt(at);
      pointer("pointerup", at);
      assert.equal(panel.dataset.size, "free", `parked at ${at}`);
      assert.equal(panel.style.height, `${at}px`);
    }
    pointer("pointerdown", 180);
    await settleAt(900);
    pointer("pointerup", 900);
    assert.equal(panel.dataset.size, "cap", "the third gesture still reaches the whole pane");
    await sleep(500);
    pointer("pointerdown", CAP);
    await settleAt(CAP - (CAP - MIN_VISIBLE_PX) - 10);
    pointer("pointerup", CAP - (CAP - MIN_VISIBLE_PX) - 10);
    await sleep(300);
    assert.equal(closed, 1, "and pushed almost shut, it closes");
  } finally { f.unmount(); }
});

// ── Source: one cap, one rule, one stylesheet answer ─────────────────────────

const pull = stripComments(readFileSync("app/lib/chrome/usePanelPull.ts", "utf8"));
const drag = stripComments(readFileSync("app/lib/chrome/usePanelDrag.ts", "utf8"));
const gest = stripComments(readFileSync("app/lib/chrome/panelGesture.ts", "utf8"));
const css = stripCssComments(readFileSync("app/components/chrome/chrome.css", "utf8"));

test("both directions read the travel from ONE helper, and neither has its own", () => {
  for (const [name, src] of [["usePanelPull", pull], ["usePanelDrag", drag]] as const) {
    assert.match(src, /paneCap\(layer\)/, `${name} reads the pane's cap through paneCap`);
    assert.doesNotMatch(src, /--pane-ceiling/, `${name} has no ceiling arithmetic of its own`);
  }
  assert.doesNotMatch(gest, /export function topCap|export function topRelease/, "the top window's own travel and release rules are gone");
  assert.match(pull, /releaseBySize\(/);
  assert.match(pull, /cancelBySize\(/);
});

test("the stylesheet lets a pulled top window reach the composer, and rests it there by rule", () => {
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]:is\(\[data-pull\], \[data-size\]\) \{ max-height: calc\(100% - var\(--pane-ceiling\)\); \}/);
  assert.match(css, /\.chrome-window-panel\[data-from="top"\]\[data-size="cap"\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/);
  // The cap rule must come after the half-height task rule it overrides (equal specificity, later wins).
  const half = css.indexOf('.chrome-window-panel[data-from="top"][data-kind="task"] { height: calc((100%');
  const cap = css.indexOf('.chrome-window-panel[data-from="top"][data-size="cap"]');
  assert.ok(half > 0 && cap > half, "vacuity anchor: both rules exist, the cap rule after the half rule");
});
