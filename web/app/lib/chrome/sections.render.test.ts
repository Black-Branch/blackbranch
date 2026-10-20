// A REAL mount of Sections — the mount-order bug this pins cannot be seen by a
// source scan, because every line of the measurement effect was present and in
// the right order while the band still painted nothing.
//
// The bug: `Band` renders the `div.chrome-band` that is an ANCESTOR of the
// strip, and React attaches a host element's ref only AFTER every descendant's
// layout effects have run (react-dom-client: recursivelyTraverseLayoutEffects,
// then safelyAttachRef). So on the first commit `band.frame.current` is still
// null inside the strip's effect B. An effect that reads the frame at EFFECT
// time therefore bails before publishing `applyRef.current`, the
// ResizeObserver's initial delivery calls the no-op initialiser, and — the deps
// being stable — nothing ever runs it again. No hole and no cap until the
// viewer happens to change section.
//
// The .tsx loader, the recording ResizeObserver and the rect stubber live in
// ../testTsx.ts, so this file is only its own fixture and assertions. Importing
// it is what arms the loader, which is why the component below is a dynamic
// import.
//
// Run: node --test app/lib/chrome/sections.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub, fakeLayout } from "../testTsx.ts";

const ro = installResizeObserverStub();
const { Sections } = await import("@/app/components/chrome/Sections");

const ITEMS = [
  { key: "one", label: "One" },
  { key: "two", label: "Two" },
  { key: "three", label: "Three" },
];

/** The frame at 0 and the three tabs at 40 / 120 / 200, so --ind-x / --ind-w carry information. */
const layout = (container: HTMLElement) =>
  fakeLayout(container, {
    ".chrome-band": { left: 0, width: 300 },
    '[role="tab"]': (i) => ({ left: 40 + i * 80, width: 80 }),
  });

test("a standalone Sections paints its band on FIRST mount, not only after a selection change", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  const render = (value: string | null) =>
    act(async () => {
      root.render(React.createElement(Sections, { items: ITEMS, value, onChange: () => {}, label: "Demo sections" }));
    });

  await render("two");

  const cap = container.querySelector<HTMLElement>(".chrome-cap")!;
  const frame = container.querySelector<HTMLElement>(".chrome-band")!;
  assert.ok(cap && frame, "the standalone Sections wrapped itself in a Band");
  assert.ok(ro.observed.length > 0, "the strip observed its list and tabs");

  layout(container);
  await act(async () => { ro.fire(); });

  assert.equal(cap.style.opacity, "0.85", "the cap must be visible after the first observation — the frame ref attaches AFTER the strip's layout effects, so an effect that reads it at effect time paints nothing and then never runs again");
  assert.equal(frame.style.getPropertyValue("--ind-x"), "120px", "the hole sits over the second tab (40 + 1*80, in band space)");
  assert.equal(frame.style.getPropertyValue("--ind-w"), "80px", "and is as wide as it");

  // value: null — the collapsed dock. The hole closes and the cap hides.
  await render(null);

  assert.equal(cap.style.opacity, "0", "nothing selected: the cap hides");
  assert.equal(frame.style.getPropertyValue("--ind-w"), "0px", "nothing selected: the hole closes, or the last selection's gap stays punched in the shade");
  assert.equal(frame.style.getPropertyValue("--ind-w2"), "0px",
    "the second hole rests closed — a single-hole consumer must never leave layer 3 open");

  await act(async () => { root.unmount(); });
  container.remove();
});

// Overflow: the strip scrolls with its scrollbar hidden, so the
// wrapper must SAY which sides hold more — and say nothing when all fits.
test("overflow: data-more marks exactly the sides with more tabs, and a chevron press scrolls the list", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Sections, { items: ITEMS, value: "one", onChange: () => {}, label: "Demo sections" }));
  });

  const wrap = container.querySelector<HTMLElement>(".chrome-sections-wrap")!;
  const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
  assert.ok(wrap && list && list.parentElement === wrap, "the tablist sits in the wrapper the chevrons hang from");

  // A strip 358 wide holding 525 of tabs (the Admin Panel at 390 px).
  const geo = { scrollLeft: 0, clientWidth: 358, scrollWidth: 525 };
  for (const k of ["clientWidth", "scrollWidth"] as const) Object.defineProperty(list, k, { get: () => geo[k], configurable: true });
  Object.defineProperty(list, "scrollLeft", { get: () => geo.scrollLeft, set: (v: number) => { geo.scrollLeft = v; }, configurable: true });
  const steps: number[] = [];
  Object.defineProperty(list, "scrollBy", { value: (o: { left: number }) => { steps.push(o.left); }, configurable: true });
  layout(container);

  await act(async () => { ro.fire(); });
  assert.equal(wrap.dataset.more, "end", "on load: more to the right only");

  geo.scrollLeft = 80;
  await act(async () => { list.dispatchEvent(new dom.window.Event("scroll")); });
  assert.equal(wrap.dataset.more, "both");

  geo.scrollLeft = 167;
  await act(async () => { list.dispatchEvent(new dom.window.Event("scroll")); });
  assert.equal(wrap.dataset.more, "start", "at the end: more to the left only");

  const [back, fwd] = Array.from(wrap.querySelectorAll<HTMLButtonElement>(":scope > .chrome-more"));
  assert.ok(back?.classList.contains("chrome-more-start") && fwd?.classList.contains("chrome-more-end"), "one chevron per side");
  for (const b of [back!, fwd!]) {
    assert.equal(b.tabIndex, -1, "the chevrons are pointer-only — the tablist's arrows already reach every tab");
    assert.equal(b.getAttribute("aria-hidden"), "true");
  }
  await act(async () => { back!.click(); fwd!.click(); });
  assert.deepEqual(steps, [-(358 - 80), 358 - 80], "a press pages most of the strip's width, in its own direction");

  // Everything fits (a desktop width): no attribute, so no fade and no chevron.
  geo.clientWidth = 768; geo.scrollWidth = 768; geo.scrollLeft = 0;
  await act(async () => { ro.fire(); });
  assert.equal(wrap.dataset.more, undefined, "nothing past either edge: the strip says nothing");

  await act(async () => { root.unmount(); });
  container.remove();
});
