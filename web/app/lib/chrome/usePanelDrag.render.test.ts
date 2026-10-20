// The panel handle's gesture, mounted
// for real: a PanelWindow inside a pane layer, driven by Pointer Events. jsdom
// lays nothing out, so geometry is stubbed the way a browser would report it
// (the layer's rect, the panel's offsetHeight, rects net of the inline
// translate), and the writes are read back through a MutationObserver with
// attributeOldValue — the only way to see the write ORDER, which is the whole
// mechanism. Timing-dependent assertions (a flick) use real time, generously.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";
import { KB_LIFT_EVENT } from "../useViewportHeightVar.ts";
import { MIN_VISIBLE_PX, FLICK_VY } from "./panelGesture.ts";

installResizeObserverStub();
const { Window } = await import("@/app/components/chrome/Window");
const { createRoot } = await import("react-dom/client");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let a synchronous pointer event's MutationRecord deliver (jsdom queues it
 *  as a microtask) before `reset()` snapshots the style — otherwise the stale
 *  record leaks into the next `translates()` read. */
const flush = () => Promise.resolve();

/** A pane layer 500px tall with a 0px ceiling, and a panel of natural height `contentH`. */
function fixture(opts: { kind?: "peek" | "task"; contentH?: number; ceiling?: number; onClose?: () => void } = {}) {
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  layer.style.setProperty("--pane-ceiling", `${opts.ceiling ?? 0}px`);
  // The layer's RECT is the cap's source — the hook must not read clientHeight,
  // which rounds while a real pane's height is fractional, so nothing stubs it.
  layer.getBoundingClientRect = () => ({ top: 0, height: 500 } as DOMRect);
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: opts.kind ?? "peek", name: "bram", onClose: opts.onClose ?? (() => {}),
      children: React.createElement("div"),
    }),
  ));
  const panel = dom.window.document.querySelector('[role="dialog"][aria-label="bram"]')! as HTMLElement;
  const grab = panel.querySelector(".chrome-window-grab")! as HTMLElement;
  const contentH = opts.contentH ?? 380;
  const capH = 500 - (opts.ceiling ?? 0);
  // The panel's BOX — the ONLY height the hook reads: content-fit at rest; the
  // cap box while dragging, at the cap detent, parked below contentFit, or for
  // a task. Nothing stubs `body.scrollHeight` or the band's height on purpose:
  // `scrollHeight` is floored at the box, so a hook that measured content
  // through it would read the CAP box back in a cap-height box and compute
  // fit = 0. contentFit is the hook's memory of the resting box instead.
  const inCapBox = () => panel.hasAttribute("data-drag") || panel.dataset.detent === "cap" || panel.dataset.detent === "free" || opts.kind === "task";
  /** Every `offsetHeight` read — the hook's layout FLUSHES — as
   *  `transitionProperty|translate` at the moment of the read. A hold and the
   *  restore of the transition property need a flush between them, or the
   *  browser transitions from the last RENDERED value; this is how a test
   *  sees that the flush happened, and with the hold still in force. */
  const flushes: string[] = [];
  Object.defineProperty(panel, "offsetHeight", {
    configurable: true,
    get: () => { flushes.push(`${panel.style.transitionProperty}|${panel.style.translate}`); return inCapBox() ? capH : Math.min(contentH, capH); },
  });
  const translateY = () => parseFloat(panel.style.translate.split(/\s+/)[1] ?? "0") || 0;
  panel.getBoundingClientRect = () => ({ top: (500 - panel.offsetHeight) + translateY() } as DOMRect);
  const olds: string[] = [];
  let baseline = "";
  const mo = new dom.window.MutationObserver((muts) => { for (const m of muts) olds.push(m.oldValue ?? ""); });
  mo.observe(panel, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  const parse = (s: string) => /translate:\s*([^;]+)/.exec(s)?.[1]?.trim() ?? null;
  /** The distinct `translate` values WRITTEN since reset() — the value that was
   *  already there (an observer's first old value) is not a write. */
  const translates = async () => {
    await flush();
    if (!olds.length) return [];
    const seq = [...olds, panel.getAttribute("style") ?? ""].map(parse);
    const distinct = seq.filter((v, i): v is string => v !== null && v !== seq[i - 1]);
    return distinct[0] === parse(baseline) ? distinct.slice(1) : distinct;
  };
  const reset = () => { olds.length = 0; baseline = panel.getAttribute("style") ?? ""; };
  const pointer = (type: string, clientY: number, extra: PointerEventInit = {}) =>
    act(() => { grab.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, clientX: 100, bubbles: true, ...extra })); });
  /** Move there and PAUSE, the way a finger about to lift does — synthetic
   *  events all share one timestamp, so without the pause every release would
   *  read as a flick. The second move is the "resting" sample. */
  const settleAt = async (clientY: number) => { pointer("pointermove", clientY); await sleep(100); pointer("pointermove", clientY); };
  const transitionEnd = () =>
    act(() => { panel.dispatchEvent(Object.assign(new dom.window.Event("transitionend", { bubbles: true }), { propertyName: "translate" })); });
  /** One K commit announced on the LAYER, the way useKeyboardLift announces it
   *  on the lifted element (the panel is a DOM descendant): before, then after. */
  const lift = (k = 300) => act(() => {
    for (const phase of ["before", "after"] as const) {
      layer.dispatchEvent(new dom.window.CustomEvent(KB_LIFT_EVENT, { bubbles: true, detail: { phase, k } }));
    }
  });
  const fit = capH - contentH;
  /** Park the resting box 100px below contentFit: press, pull, pause, let go. */
  const park = async () => { pointer("pointerdown", 400); await settleAt(500); await flush(); pointer("pointerup", 500); await flush(); };
  return {
    panel, grab, layer, translates, reset, pointer, settleAt, transitionEnd, lift, park, flushes,
    fit,
    /** The lowest scalar that still shows MIN_VISIBLE_PX of the box. */
    floor: capH - MIN_VISIBLE_PX,
    /** A finger position (from a press at 400 on the resting box) that puts the box under the minimum. */
    underMin: 400 + (capH - MIN_VISIBLE_PX - fit) + 20,
    unmount: () => { mo.disconnect(); act(() => root.unmount()); layer.remove(); host.remove(); },
  };
}

test("the handle renders: a grabber pill above the band, inside ONE grab surface", () => {
  const f = fixture();
  try {
    const grabber = f.grab.querySelector(".chrome-window-grabber");
    assert.ok(grabber, "the pill is the visible affordance of the drag surface");
    assert.equal(grabber!.getAttribute("aria-hidden"), "true", "decorative — the band's controls carry the semantics");
    assert.ok(f.grab.querySelector(".chrome-bar-top"), "the band is inside the same surface: pill + band are one handle");
    assert.equal(f.grab.nextElementSibling?.className.includes("chrome-window-body"), true, "the body is NOT part of the handle — scrolling a list stays scrolling");
  } finally { f.unmount(); }
});

test("drag up from contentFit: the cap box is adopted at translate = fit (nothing visible changes), then the scalar follows the finger", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    assert.ok(f.panel.hasAttribute("data-drag"), "the gesture's box is the cap box");
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`], "adopted at fit: the cap box translated by fit IS the resting content-fit box's visible region");
    assert.equal(f.panel.style.transitionProperty, "none", "held, not animated");
    f.reset();
    f.pointer("pointermove", 403); // inside the slop
    assert.deepEqual(await f.translates(), [], "a press that has not travelled DRAG_SLOP_PX is a tap in progress, not a drag");
    f.pointer("pointermove", 370); // −30
    assert.deepEqual(await f.translates(), [`0 ${f.fit - 30}px`], "the finger's delta, 1:1 inside [0, fit]");
  } finally { f.unmount(); }
});

test("release nearer the cap snaps to the cap; transitionend restores the resting cap box at translate 0", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(400 - f.fit + 10); // 10px short of the cap, then a pause: no flick
    f.reset();
    f.pointer("pointerup", 400 - f.fit + 10);
    assert.deepEqual(await f.translates(), ["0 0"], "released from where it is (already the baseline) to the cap detent, on the stylesheet's transition");
    assert.equal(f.panel.style.transitionProperty, "", "the transition carries the snap");
    assert.ok(f.panel.hasAttribute("data-drag"), "the cap box is HELD until the transition ends");
    f.transitionEnd();
    assert.ok(!f.panel.hasAttribute("data-drag"), "settled");
    assert.equal(f.panel.dataset.detent, "cap", "resting AT the cap: the detent box replaces the held box at an identical region");
    assert.equal(f.panel.style.translate, "0 0", "the scalar is zeroed in the same frame the resting box comes back");
  } finally { f.unmount(); }
});

test("release nearer contentFit (from above it) springs back to it; settling returns the content-fit box (no detent attribute)", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(380); // −20, still nearer fit; paused, so no flick
    f.reset();
    f.pointer("pointerup", 380);
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`], "back to contentFit on the transition");
    f.transitionEnd();
    assert.ok(!f.panel.hasAttribute("data-drag"));
    assert.equal(f.panel.dataset.detent, undefined, "resting at contentFit is the plain content-fit box");
    assert.equal(f.panel.style.translate, "0 0", "…at translate 0 — the fit box at 0 and the cap box at fit show the same region");
  } finally { f.unmount(); }
});

test("drag back from the cap detent to contentFit tracks 1:1 and settles to the content-fit box", async () => {
  // The cap detent's box IS cap height, so any measurement taken FROM the box
  // there reports the cap and makes fit 0 — no range to drag back through, a
  // drag down straight into the free range, and a spring-back that collapses
  // the box unanimated. contentFit is the hook's memory of the RESTING box
  // instead, taken at the press that left it.
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(400 - f.fit + 10); // up to the cap, paused: no flick
    f.pointer("pointerup", 400 - f.fit + 10);
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, "cap", "setup: resting AT the cap, in the cap box");
    f.reset();
    f.pointer("pointerdown", 300);
    await f.settleAt(300 + f.fit - 10); // 10px short of contentFit
    assert.equal((await f.translates()).at(-1), `0 ${f.fit - 10}px`,
      "1:1 inside [0, fit] — the range still exists from the cap detent, so the panel can be dragged back down");
    f.reset();
    f.pointer("pointerup", 300 + f.fit - 10);
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`], "released to contentFit, the nearest detent");
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, undefined, "the plain content-fit box is back");
    assert.ok(!f.panel.hasAttribute("data-drag"));
    assert.equal(f.panel.style.translate, "0 0", "…at translate 0 — the same visible region, not a collapsed box");
  } finally { f.unmount(); }
});

test("drag down past contentFit follows the finger 1:1; a release with less than MIN_VISIBLE_PX showing dismisses through requestClose (the ONE close path)", async () => {
  let closed = 0;
  const f = fixture({ onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 500); // +100 below fit
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`, `0 ${f.fit + 100}px`], "below contentFit the box follows the finger undamped — a position, not a rubber band (L2.1)");
    f.pointer("pointermove", f.underMin);
    await flush();
    f.reset();
    f.flushes.length = 0;
    f.pointer("pointerup", f.underMin);
    assert.ok(f.panel.hasAttribute("data-closing"), "dismiss = requestClose = the exit animation armed, same as ✕ / Escape / back");
    assert.equal(f.panel.style.transitionProperty, "", "the box is left where the finger let go; panel-seam-out runs on transform from there");
    assert.deepEqual(f.flushes, [`none|0 ${f.fit + (f.underMin - 400)}px`],
      "ONE layout flush between the last hold and the transition restore, with the hold still in force at the released translate — " +
      "a flick's last move and its release land in the same task, and restoring the property before a recalc would transition the box from the last RENDERED value under the exit (it eases down from the cap while sliding out)");
    assert.deepEqual(await f.translates(), [], "no snap-back write competes with the exit");
    // PanelWindow's close backstop delivers onClose when no animationend comes (jsdom).
    await sleep(300);
    assert.equal(closed, 1, "delivered once, by the panel's own close path");
  } finally { f.unmount(); }
});

test("a release below contentFit with the handle still showing PARKS the box there — static repositioning", async () => {
  let closed = 0;
  const f = fixture({ onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(500); // +100: 280px of a 500px cap box still showing
    await flush();
    f.reset();
    f.pointer("pointerup", 500);
    assert.ok(!f.panel.hasAttribute("data-closing"), "not a dismiss: the appearance menu can be pulled down to see the chat behind it");
    assert.deepEqual(await f.translates(), [], "no spring-back write — the box stays exactly where the finger let go");
    assert.ok(!f.panel.hasAttribute("data-drag"), "settled at once: there is nothing to animate");
    assert.equal(f.panel.dataset.detent, "free", "a parked box is the cap box at a free scalar — `data-detent=\"free\"` keeps it cap height");
    assert.equal(f.panel.style.translate, `0 ${f.fit + 100}px`, "the scalar is KEPT, not zeroed: this box has no resting rule of its own");
    assert.equal(f.panel.style.transitionProperty, "", "nothing left suppressed on a resting box");
    assert.equal(closed, 0);
    // And it can be pulled back: a press adopts the position, the drag is 1:1
    // straight through contentFit, and a release above it lands on a detent.
    f.reset();
    f.pointer("pointerdown", 500);
    assert.deepEqual(await f.translates(), [], "the press adopts exactly where the box is — nothing moves");
    assert.ok(f.panel.hasAttribute("data-drag"));
    f.pointer("pointermove", 390); // −110: 10px ABOVE contentFit
    assert.deepEqual(await f.translates(), [`0 ${f.fit - 10}px`], "1:1 through contentFit — no seam between the free range and the detent range");
    await f.settleAt(390);
    await flush();
    f.reset();
    f.pointer("pointerup", 390);
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`], "above contentFit the detents rule again: the nearest one");
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, undefined, "the plain content-fit box is back — the parked position was per-open, and it is gone");
    assert.ok(!f.panel.hasAttribute("data-drag"));
    assert.equal(f.panel.style.translate, "0 0");
  } finally { f.unmount(); }
});

test("a PARKED box publishes its clipped depth, so its body can still be scrolled to the end", async () => {
  // A panel pulled halfway down must still scroll to its bottom. A parked
  // box keeps the CAP box and is pushed down by its scalar, so its bottom
  // `translate` px sit past the layer's clip edge — and the body is sized by
  // the BOX, so its scroll range ends with exactly those px still hidden. The
  // stylesheet pads the body by `--panel-park` to give that depth back
  // (chrome.css, `[data-detent="free"]`); this pins the number it reads.
  const f = fixture();
  try {
    assert.equal(f.panel.style.getPropertyValue("--panel-park"), "", "a resting box clips nothing, and nothing has written a pad yet");
    await f.park();
    assert.equal(f.panel.dataset.detent, "free", "vacuity anchor: the box really did park — on any other settle the pad below says nothing");
    assert.equal(
      f.panel.style.getPropertyValue("--panel-park"), `${f.fit + 100}px`,
      "the pad must equal the scalar exactly: that IS how far the box hangs past the clip edge, and a short pad still leaves the end of the content unreachable",
    );
    // Pull it back above contentFit: the resting box clips nothing, so a pad
    // left behind would open dead space under the content instead.
    f.pointer("pointerdown", 500);
    f.pointer("pointermove", 390);
    await f.settleAt(390);
    await flush();
    f.pointer("pointerup", 390);
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, undefined, "vacuity anchor: back in the content-fit box");
    assert.equal(f.panel.style.getPropertyValue("--panel-park"), "0", "a resting box clips nothing — the pad has to go with the park");
  } finally { f.unmount(); }
});

test("and the stylesheet actually SPENDS that depth on the body's padding", async () => {
  // Without this, the test above passes while the fix does nothing: a custom
  // property no rule reads is a remedy with no reader. jsdom lays nothing out,
  // so the rule itself is the assertion — the behaviour it produces was
  // measured in a real browser at 390px wide (parked 110px, body scrolled
  // fully down: the last control moved from 49px BELOW the fold to flush
  // against the visible edge).
  const css = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../components/chrome/chrome.css", import.meta.url), "utf8"));
  const rule = /\.chrome-window-panel\[data-detent="free"\][^{]*\.chrome-window-body\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule?.[1], "no rule pads a PARKED panel's body — `--panel-park` is written and never spent, and the bottom of the content is unreachable again");
  assert.ok(
    /padding-block-end:\s*var\(--panel-park/.test(rule[1]),
    "the parked-body rule no longer pads by --panel-park; whatever it does instead has to give the clipped depth back some other way",
  );
});

test("a flick UP from a parked box goes to contentFit — the next detent up, one step per gesture", async () => {
  const f = fixture();
  try {
    await f.park();
    assert.equal(f.panel.dataset.detent, "free", "setup: parked 100px below contentFit");
    f.reset();
    f.pointer("pointerdown", 500);
    f.pointer("pointermove", 480);
    await sleep(20);
    f.pointer("pointermove", 440); // −60 in ~20ms ≫ FLICK_VY, upward
    f.pointer("pointerup", 440);
    assert.ok(!f.panel.hasAttribute("data-closing"));
    assert.equal((await f.translates()).at(-1), `0 ${f.fit}px`, `a ${FLICK_VY}px/ms upward flick lands on contentFit, not the cap`);
    assert.ok(f.panel.hasAttribute("data-drag"), "the snap is in flight");
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, undefined, "resting at contentFit: the content-fit box, the parked position forgotten");
    assert.equal(f.panel.style.translate, "0 0");
  } finally { f.unmount(); }
});

test("a fast downward flick from below contentFit dismisses; from the cap it stops at contentFit", async () => {
  let closed = 0;
  const f = fixture({ onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 420);
    await sleep(20);
    f.pointer("pointermove", 460); // ~40px in ~20ms ≫ FLICK_VY
    f.pointer("pointerup", 460);
    assert.ok(f.panel.hasAttribute("data-closing"), `a ${FLICK_VY}px/ms downward flick below contentFit dismisses — the fast way out of a parked window`);
    await sleep(300);
    assert.equal(closed, 1);
  } finally { f.unmount(); }
  const g = fixture();
  try {
    g.pointer("pointerdown", 400);
    g.pointer("pointermove", 400 - g.fit); // at the cap
    g.pointer("pointerup", 400 - g.fit);
    g.transitionEnd();
    assert.equal(g.panel.dataset.detent, "cap", "setup: resting at the cap");
    g.reset();
    g.pointer("pointerdown", 400 - g.fit);
    g.pointer("pointermove", 400 - g.fit + 20);
    await sleep(20);
    g.pointer("pointermove", 400 - g.fit + 60);
    g.pointer("pointerup", 400 - g.fit + 60);
    assert.ok(!g.panel.hasAttribute("data-closing"), "a flick from the cap must not fling the window off the screen");
    assert.equal((await g.translates()).at(-1), `0 ${g.fit}px`, "it lands on the next detent, contentFit");
  } finally { g.unmount(); }
});

test("pointercancel (the pager took a horizontal pan): above contentFit springs to the nearest detent, below it the box stays parked — never a dismiss, never a stuck drag", async () => {
  let closed = 0;
  const f = fixture({ onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 370); // −30: above contentFit, nearer fit than the cap
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`, `0 ${f.fit - 30}px`], "setup: in the detent range");
    f.reset();
    f.pointer("pointercancel", 370);
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`], "back to the nearest detent on the transition — a cancel has no velocity");
    f.transitionEnd();
    assert.ok(!f.panel.hasAttribute("data-drag"));
    assert.equal(closed, 0);
  } finally { f.unmount(); }
  const g = fixture({ onClose: () => { closed++; } });
  try {
    g.pointer("pointerdown", 400);
    g.pointer("pointermove", 500); // +100: parked territory
    await flush();
    g.reset();
    g.pointer("pointercancel", 500);
    assert.ok(!g.panel.hasAttribute("data-closing"));
    assert.deepEqual(await g.translates(), [], "the box stays where the finger had it — a cancel is not a reason to move a repositioned window");
    assert.ok(!g.panel.hasAttribute("data-drag"), "settled at once");
    assert.equal(g.panel.dataset.detent, "free");
    assert.equal(closed, 0);
  } finally { g.unmount(); }
  // A cancel with the box under the minimum must never dismiss — unlike a real
  // release, distance never applies; it eases the box up to the floor instead.
  const h = fixture({ onClose: () => { closed++; } });
  try {
    h.pointer("pointerdown", 400);
    h.pointer("pointermove", h.underMin);
    await flush();
    h.reset();
    h.pointer("pointercancel", h.underMin);
    assert.ok(!h.panel.hasAttribute("data-closing"), "a cancel is never a dismiss, however far past contentFit the finger had gone");
    assert.deepEqual(await h.translates(), [`0 ${h.floor}px`], "eased up to the floor: the lowest position that still shows the handle");
    h.transitionEnd();
    assert.equal(h.panel.dataset.detent, "free", "…and parked there");
    assert.equal(h.panel.style.translate, `0 ${h.floor}px`);
    assert.ok(!h.panel.hasAttribute("data-drag"));
    assert.equal(closed, 0);
  } finally { h.unmount(); }
});

test("a tap (no travel) writes no motion and settles immediately; a press on a band BUTTON is not a drag at all", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    f.reset();
    f.pointer("pointerup", 400);
    assert.deepEqual(await f.translates(), ["0 0"], "the cap box is left in the same frame — one write, back to the resting scalar");
    assert.ok(!f.panel.hasAttribute("data-drag"), "settled without a transition (there is nothing to animate)");
    const close = f.panel.querySelector('button[aria-label="Close"]')!;
    f.reset();
    act(() => { close.dispatchEvent(new dom.window.PointerEvent("pointerdown", { pointerId: 2, button: 0, clientY: 400, bubbles: true })); });
    assert.ok(!f.panel.hasAttribute("data-drag"), "the closest() guard: a press on anything interactive is not a drag");
    assert.deepEqual(await f.translates(), []);
  } finally { f.unmount(); }
});

test("task kind: fit = 0 — dragging up clamps at the cap; dragging down parks it (a task can be pulled down to peek too); under the minimum it dismisses", async () => {
  let closed = 0;
  const f = fixture({ kind: "task", onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 380);
    assert.deepEqual(await f.translates(), ["0 0"], "above the cap: clamped at the only detent — no strain, the box never leaves the composer (fit is 0)");
    await f.settleAt(440); // +40
    assert.equal((await f.translates()).at(-1), "0 40px", "everything below a task's cap is free");
    await flush();
    f.reset();
    f.pointer("pointerup", 440);
    assert.ok(!f.panel.hasAttribute("data-closing"));
    assert.equal(f.panel.dataset.detent, "free", "parked");
    assert.equal(f.panel.style.translate, "0 40px");
    f.pointer("pointerdown", 440);
    f.pointer("pointermove", 440 + (f.floor - 40) + 20); // the box under the minimum
    f.pointer("pointerup", 440 + (f.floor - 40) + 20);
    assert.ok(f.panel.hasAttribute("data-closing"));
    await sleep(300);
    assert.equal(closed, 1);
  } finally { f.unmount(); }
});

test("the backstop settles a release whose transitionend never comes (reduced motion)", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 380);
    f.pointer("pointerup", 380);
    assert.ok(f.panel.hasAttribute("data-drag"));
    await sleep(300); // SETTLE_BACKSTOP_MS (250) + margin
    assert.ok(!f.panel.hasAttribute("data-drag"), "a hold must never outlive the motion");
  } finally { f.unmount(); }
});

test("a press while the lift-follow holds the box (data-lifting) is ignored — the two holds never overlap", async () => {
  const f = fixture();
  try {
    f.panel.dataset.lifting = "";
    f.reset();
    f.pointer("pointerdown", 400);
    assert.ok(!f.panel.hasAttribute("data-drag"), "a keyboard commit's 200ms hold wins; the next press works");
    assert.deepEqual(await f.translates(), []);
  } finally { f.unmount(); }
});

test("a second pointer landing mid-drag does not take over the gesture", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400); // id 1 (default)
    f.reset();
    f.pointer("pointerdown", 450, { pointerId: 2 });
    assert.ok(f.panel.hasAttribute("data-drag"), "id 1's gesture still owns the box");
    assert.deepEqual(await f.translates(), [], "a second pointerdown writes nothing — the first gesture is untouched");
    f.pointer("pointermove", 480, { pointerId: 2 });
    assert.deepEqual(await f.translates(), [], "a pointermove from the second pointer is ignored");
    f.pointer("pointerup", 400); // id 1's release
    assert.ok(!f.panel.hasAttribute("data-drag"), "id 1's own release still settles the gesture");
  } finally { f.unmount(); }
});

test("the drag surface never costs the keyboard: pointerdown is defaultPrevented, so no compat mousedown moves focus", () => {
  const f = fixture();
  try {
    const ev = new dom.window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientY: 400, bubbles: true, cancelable: true });
    act(() => { f.grab.dispatchEvent(ev); });
    assert.ok(ev.defaultPrevented, "keepFocus.ts's rule one level down — the composer under an open card keeps the keyboard through a drag");
    f.pointer("pointerup", 400);
  } finally { f.unmount(); }
});

test("a K commit under a held finger CANCELS the gesture: above contentFit to the nearest detent, below it to a parked position — never eased out from under the finger, never a dismiss", async () => {
  let closed = 0;
  const f = fixture({ onClose: () => { closed++; } });
  try {
    f.pointer("pointerdown", 400);
    f.pointer("pointermove", 370); // −30: above contentFit
    await flush();
    f.reset();
    f.lift();
    assert.ok(f.panel.hasAttribute("data-drag"), "the cap box is still held — the cancel's snap is in flight");
    assert.ok(!f.panel.hasAttribute("data-closing"));
    assert.deepEqual(await f.translates(), [`0 ${f.fit}px`],
      "released to the nearest detent, so the lift-follow has a pending detent to retarget instead of `restTranslate` reporting 0 with the finger down");
    f.reset();
    f.pointer("pointermove", 480);
    assert.deepEqual(await f.translates(), [], "the gesture ended with the commit — a further move is not a drag");
    f.pointer("pointerup", 480);
    assert.ok(!f.panel.hasAttribute("data-closing"), "…and neither is its release");
    assert.equal(closed, 0);
  } finally { f.unmount(); }
  const g = fixture({ onClose: () => { closed++; } });
  try {
    g.pointer("pointerdown", 400);
    g.pointer("pointermove", g.underMin); // the box under the minimum, finger still down
    await flush();
    g.reset();
    g.lift();
    assert.ok(!g.panel.hasAttribute("data-closing"), "a keyboard commit is never a dismiss, however far past contentFit the finger was");
    assert.deepEqual(await g.translates(), [`0 ${g.floor}px`], "cancelled to the floor — a parked position the lift-follow can carry across the new cap");
    g.pointer("pointermove", g.underMin + 40);
    g.pointer("pointerup", g.underMin + 40);
    assert.ok(!g.panel.hasAttribute("data-closing"), "the gesture ended with the commit");
    assert.equal(closed, 0);
  } finally { g.unmount(); }
});

test("a lift that retargets a snap RE-ARMS the settle backstop — the retargeted transition gets its full life", async () => {
  const f = fixture();
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(380);
    f.pointer("pointerup", 380);
    assert.ok(f.panel.hasAttribute("data-drag"), "setup: the snap to contentFit is in flight");
    await sleep(150);
    f.lift();
    await sleep(150); // 300ms since the release — past the ORIGINAL backstop
    assert.ok(f.panel.hasAttribute("data-drag"),
      "the original timer would have dropped the held box part-way through the transition the lift just restarted");
    f.transitionEnd();
    assert.ok(!f.panel.hasAttribute("data-drag"), "and the retargeted snap still settles on its own transitionend");
  } finally { f.unmount(); }
});

test("no press during the entry or the exit animation: both run panel-seam-in/out on a PERCENTAGE base", async () => {
  const f = fixture();
  try {
    // Entry: PanelWindow marks the panel entered when the freeze releases (or
    // immediately when there was nothing to freeze, which is jsdom's bare mount).
    assert.equal(f.panel.dataset.entered, "", "setup: this mount had no measurable height to freeze, so the entry is already done");
    delete f.panel.dataset.entered;
    f.reset();
    f.pointer("pointerdown", 400);
    assert.ok(!f.panel.hasAttribute("data-drag"), "a press mid-entry would re-target the slide's percentage base and switch the box under it");
    assert.deepEqual(await f.translates(), []);
    f.panel.dataset.entered = "";
    f.pointer("pointerdown", 400);
    assert.ok(f.panel.hasAttribute("data-drag"), "…and the same press works once the entry has landed");
    f.pointer("pointerup", 400);
  } finally { f.unmount(); }
  // Exit: the same guard on the way out, reached the real way — a swipe dismiss.
  const g = fixture();
  try {
    g.pointer("pointerdown", 400);
    g.pointer("pointermove", g.underMin);
    g.pointer("pointerup", g.underMin);
    assert.ok(g.panel.hasAttribute("data-closing"), "setup: the exit is armed");
    await flush();
    g.reset();
    g.pointer("pointerdown", 400);
    // `data-drag` cannot answer this one: a dismiss deliberately LEAVES the
    // held box where the finger let go. A press would re-suppress the
    // transition and re-hold the scalar — neither happens.
    assert.equal(g.panel.style.transitionProperty, "", "a press during the exit animation is ignored");
    assert.deepEqual(await g.translates(), [], "nothing competes with panel-seam-out");
    await sleep(300); // let the close backstop deliver before the unmount
  } finally { g.unmount(); }
});

test("re-pressing a box mid-snap continues from the interpolated value — no jump", async () => {
  const f = fixture();
  try {
    await f.park();
    f.pointer("pointerdown", 500);
    f.pointer("pointermove", 480);
    await sleep(20);
    f.pointer("pointermove", 440);
    f.pointer("pointerup", 440); // an upward flick: the snap to contentFit is in flight
    assert.ok(f.panel.hasAttribute("data-drag"), "setup: the cap box still held, easing toward contentFit");
    // Mid-flight the box is 50px below contentFit. jsdom's computed style IS
    // the inline value, so stand in for the interpolated value the way the
    // lift-follow's own retarget test does.
    f.panel.style.translate = `0 ${f.fit + 50}px`;
    await flush();
    f.reset();
    f.pointer("pointerdown", 500);
    assert.deepEqual(await f.translates(), [], "the press adopts exactly where the box is — nothing moves");
    f.pointer("pointermove", 510); // +10 of finger
    assert.deepEqual(await f.translates(), [`0 ${f.fit + 60}px`], "continuous from fit + 50: 10 more finger px are 10 more scalar px");
    f.pointer("pointercancel", 510);
  } finally { f.unmount(); }
});

test("unmounting mid-snap clears the settle backstop — no timer writes to a torn-down panel", async () => {
  const f = fixture();
  f.pointer("pointerdown", 400);
  await f.settleAt(380);
  f.pointer("pointerup", 380);
  assert.ok(f.panel.hasAttribute("data-drag"), "setup: a release backstop is armed");
  const style = f.panel.getAttribute("style");
  f.unmount();
  await sleep(300); // past SETTLE_BACKSTOP_MS
  assert.equal(f.panel.getAttribute("style"), style, "the effect's cleanup cleared the timer — settle() never ran on the detached node");
});

test("a task window never carries data-detent=\"cap\" — its box is cap height at rest, so there is no detent box to swap in", async () => {
  const f = fixture({ kind: "task" });
  try {
    f.pointer("pointerdown", 400);
    await f.settleAt(390); // up, straining against the cap
    f.pointer("pointerup", 390);
    f.transitionEnd();
    assert.equal(f.panel.dataset.detent, undefined, "data-detent=\"cap\" on a task would be a second rule for the box it already has");
    assert.ok(!f.panel.hasAttribute("data-drag"), "settled");
    assert.equal(f.panel.style.translate, "0 0");
  } finally { f.unmount(); }
});

test("the fallback shape (no pane layer registered) has no handle at all — and a press on it throws nothing", async () => {
  _resetWindowLayerForTests(); // no registerPaneTarget: getActiveTarget() finds nothing
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name: "fallback", onClose: () => {},
      children: React.createElement("div"),
    }),
  ));
  const panel = dom.window.document.querySelector('[role="dialog"][aria-label="fallback"]')! as HTMLElement;
  assert.ok(panel.className.includes("chrome-window-sheet"), "no layer → the pre-L1 sheet fallback, unchanged");
  assert.equal(panel.querySelector(".chrome-window-grab"), null, "the drag surface belongs to the layer-registered shape only");
  act(() => { panel.dispatchEvent(new dom.window.PointerEvent("pointerdown", { pointerId: 1, button: 0, clientY: 400, bubbles: true })); });
  assert.ok(!panel.hasAttribute("data-drag"), "nothing to press: the gesture never attaches");
  assert.equal(panel.style.translate, "", "and nothing writes the scalar the fallback has no model for");
  act(() => root.unmount());
  host.remove();
});
