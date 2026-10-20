// web/app/lib/chrome/windowLoading.render.test.ts
// In-window loading: a panel window opens
// at its EXPECTED contentFit with a content-shaped placeholder instead of a
// blank pane, optionally with the readiness stages of the subsystems it is
// waiting on, and grows into the real content when `loading` clears (the
// content-growth follow carries that change).
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";
import { registerReadiness, _resetReadinessForTests } from "../readiness.ts";

installResizeObserverStub();
const { Window } = await import("@/app/components/chrome");
const { createRoot } = await import("react-dom/client");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");

function mount(loading: { height: number; readiness?: readonly string[]; label?: string } | null) {
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const render = (l: typeof loading) => act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name: "card", onClose: () => {}, loading: l,
      children: React.createElement("div", { "data-content": "" }, "the real content"),
    }),
  ));
  render(loading);
  const panel = () => dom.window.document.querySelector('[role="dialog"][aria-label="card"]')! as HTMLElement;
  return { panel, render, unmount: () => { act(() => root.unmount()); layer.remove(); host.remove(); } };
}

test("loading renders a placeholder at least `height` tall INSTEAD of the children, then swaps to the children when it clears", () => {
  const m = mount({ height: 320, label: "Opening the card" });
  try {
    const body = m.panel().querySelector(".chrome-window-body")!;
    const ph = body.querySelector(".chrome-window-loading") as HTMLElement;
    assert.ok(ph, "the placeholder is inside the body — the band and the handle are untouched");
    assert.equal(ph.style.minBlockSize, "320px", "the expected contentFit: the panel opens at the size the content will have, and grows into it (min, not height — content taller than the estimate must not clip)");
    assert.equal(ph.getAttribute("role"), "status");
    assert.equal(ph.querySelector(".sr-only")?.textContent, "Opening the card");
    assert.equal(ph.querySelectorAll(".chrome-window-skeleton-line").length, 3, "content-shaped: three skeleton lines, the last short");
    assert.equal(body.querySelector("[data-content]"), null, "the children are NOT mounted behind the placeholder — a tenant's mount effects must not run against a pane the user cannot see");
    m.render(null);
    assert.equal(m.panel().querySelector(".chrome-window-loading"), null);
    assert.ok(m.panel().querySelector("[data-content]"), "the real content, in the same body");
  } finally { m.unmount(); }
});

test("readiness composes a compact BootSequence into the placeholder, which then owns the status role", () => {
  _resetReadinessForTests();
  registerReadiness("matrix", [{ id: "sdk", label: "Loading Matrix" }]);
  const m = mount({ height: 200, readiness: ["matrix"], label: "Opening the channel" });
  try {
    const ph = m.panel().querySelector(".chrome-window-loading") as HTMLElement;
    const boot = ph.querySelector(".chrome-boot") as HTMLElement;
    assert.ok(boot);
    assert.ok(boot.hasAttribute("data-compact"));
    assert.equal(ph.getAttribute("role"), null, "one status region, not two nested — the sequence announces");
    assert.equal(boot.querySelector(".sr-only")?.textContent, "Opening the channel: waiting");
  } finally { m.unmount(); }
});

test("the sheet fallback (no pane layer) honours loading the same way", () => {
  _resetWindowLayerForTests();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name: "fallback", onClose: () => {}, loading: { height: 120 },
      children: React.createElement("div", { "data-content": "" }),
    }),
  ));
  const panel = dom.window.document.querySelector('[role="dialog"][aria-label="fallback"]')! as HTMLElement;
  assert.ok(panel.className.includes("chrome-window-sheet"), "setup: the pre-L1 fallback shape");
  assert.ok(panel.querySelector(".chrome-window-loading"));
  assert.equal(panel.querySelector("[data-content]"), null);
  act(() => root.unmount());
  host.remove();
});
