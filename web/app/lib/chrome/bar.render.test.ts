// A REAL mount of Bar — the two things about it a source scan cannot see.
//
// 1. The hole is measured in BAND space. A `Bar band` puts the Band around the
//    WHOLE strip, so the leading slot sits inside it, before the tabs. Anything
//    measuring with offsetLeft (or against the tab list rather than the band)
//    would put the hole under the wrong tab by exactly the leading slot's
//    width, and every line of Sections' effect would still read correctly.
//    Here the leading slot is 40px wide and the active tab is the second: band
//    space (tab − frame) reads 120, strip space (tab − tablist) reads 80. The
//    fixture stubs the TABLIST's rect too, which is what makes those two
//    numbers differ — see `layout` below.
//
// 2. `inert` / `aria-hidden` / `data-state` are three renderings of one prop
//    and they must agree on the DOM, not in the JSX: a hidden bar is inert (its
//    controls leave the tab order) while an overlay bar never is —
//    a keyboard user tabbing into it is what reveals it.
//    `inert={false}` must leave NO attribute behind, or an overlay bar is a
//    keyboard dead end.
//
// 3. The Band OUTLIVES the Sections. `center` is a prop, and the chat bar swaps
//    it from the strip to the split view's `Panes` when split view turns on —
//    the Bar, and so the Band, survives that swap. Nothing in either component's
//    source says who closes the hole when the last thing that could measure it
//    leaves; only a mount/unmount can tell.
//
// The .tsx loader, the recording ResizeObserver and the rect stubber live in
// ../testTsx.ts, so this file is only its own fixture and assertions. Importing
// it is what arms the loader, which is why the components below are dynamic
// imports.
//
// Run: node --test app/lib/chrome/bar.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub, installRafStub, fakeLayout } from "../testTsx.ts";

const ro = installResizeObserverStub();
// Installed at module scope, like `ro` above — not inside a test body — so it
// is live (and never silently uninstalled mid-file) for every test below that
// needs it, matching the one precedent this harness already has for a global
// stub. `uninstall()` exists for a consumer that wants narrower scope.
const raf = installRafStub();
const { Bar } = await import("@/app/components/chrome/Bar");
const { Sections } = await import("@/app/components/chrome/Sections");

const ITEMS = [
  { key: "a", label: "A" },
  { key: "b", label: "B" },
  { key: "c", label: "C" },
];

/**
 * The band frame at 0, the tab LIST at 40 (the leading slot is 40px of it), and
 * the three tabs at 40 / 120 / 200.
 *
 * The tablist rect is what makes this fixture discriminate. Band space reads
 * tab − frame = 120; strip space reads tab − list = 80. Leave the list at
 * jsdom's zero and both spaces answer 120, so a strip-space implementation
 * passes and the test's whole claim is empty.
 */
const layout = (container: HTMLElement) =>
  fakeLayout(container, {
    ".chrome-band": { left: 0, width: 400 },
    '[role="tablist"]': { left: 40, width: 360 },
    '[role="tab"]': (i) => ({ left: 40 + i * 80, width: 80 }),
  });

test("a band Bar spans its Band across the whole strip, and hidden/overlay reach the DOM", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  // `center` is in the state spread on purpose: it defaults to the strip and a
  // caller can replace it, which is exactly the swap split view performs.
  const render = (state: { hidden?: boolean; overlay?: boolean; center?: ReturnType<typeof React.createElement> }) =>
    act(async () => {
      root.render(
        React.createElement(Bar, {
          slot: "top",
          name: "t",
          band: true,
          leading: React.createElement("button", null, "L"),
          center: React.createElement(Sections, { items: ITEMS, value: "b", onChange: () => {}, label: "Demo" }),
          ...state,
        }),
      );
    });

  await render({});

  const bar = container.firstElementChild as HTMLElement;
  assert.equal(bar.tagName, "DIV");
  assert.equal(bar.className, "chrome-bar chrome-bar-top", "one strip, one slot class — and no className prop to widen it");
  assert.equal(bar.getAttribute("data-bar"), "t", "the consumer CSS hook");
  assert.equal(bar.hasAttribute("data-state"), false, "at rest a bar is neither hidden nor overlay");
  assert.equal(bar.hasAttribute("inert"), false, "a bar at rest is in the tab order");

  layout(container);
  await act(async () => { ro.fire(); });

  const cap = container.querySelector<HTMLElement>(".chrome-cap")!;
  const frame = container.querySelector<HTMLElement>(".chrome-band")!;
  assert.equal(cap.style.opacity, "0.85", "the cap is painted by the first observation");
  assert.equal(frame.style.getPropertyValue("--ind-x"), "120px", "the hole is measured in BAND space: the second tab at 120, not 80 — the leading slot is inside the band, before the strip");
  assert.equal(frame.style.getPropertyValue("--ind-w"), "80px", "and is as wide as that tab");

  await render({ hidden: true });

  assert.equal(bar.getAttribute("data-state"), "hidden");
  assert.equal(bar.hasAttribute("inert"), true, "a hidden bar's controls leave the tab order");
  assert.equal(bar.getAttribute("aria-hidden"), "true");

  await render({ overlay: true });

  assert.equal(bar.getAttribute("data-state"), "overlay");
  assert.equal(bar.hasAttribute("inert"), false, "an overlay bar is NEVER inert — tabbing into it is what reveals it");
  assert.equal(bar.hasAttribute("aria-hidden"), false);
  assert.equal(container.querySelectorAll(".chrome-bar-zone").length, 0, "there is no zone ELEMENT — proximity reveal is coordinate-driven, pinned below");

  // The strip leaves, the Band stays — split view (ChatTabBar swaps `center`
  // for a `Panes`; a plain div stands in here, so this stays a test of the
  // Bar). The Band is the same DOM element throughout, so whatever the last
  // paint left behind is still on it.
  await render({ center: React.createElement("div", null, "split") });

  assert.equal(container.querySelector(".chrome-sections"), null, "the strip really did unmount");
  assert.equal(container.querySelector(".chrome-band"), frame, "…and the Band it was painting is the same element, still mounted");
  assert.equal(frame.style.getPropertyValue("--ind-w"), "0px", "a Sections that unmounts inside a surviving Band closes the hole — otherwise split view keeps a gap punched in the shade under a control that has no tabs");
  assert.equal(cap.style.opacity, "0", "…and puts the cap out with it");

  await act(async () => { root.unmount(); });
  container.remove();
});

// Coordinate-driven proximity reveal — not an element zone, which would sit on
// top of the host's own content (elementFromPoint returning the zone instead
// of, say, the radio card's controls in theatre) and oscillate (revealing
// moves the zone, which un-hovers the pointer, which parks the bar, which
// re-arms the zone). Neither defect is visible to a source scan —
// chromeSkins.test.ts pins that no zone element or rules exist; only a real
// mount can prove the listener actually reveals on proximity, holds through
// hysteresis instead of flickering, and stops reacting once overlay/hidden
// say it should not be listening at all.
test("overlay proximity reveal is coordinate-driven: HOST-edge distance sets data-revealed with hysteresis, and the listener is live only while overlay && !hidden", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  const render = (state: { overlay?: boolean; hidden?: boolean }) =>
    act(async () => {
      root.render(React.createElement(Bar, { slot: "top", name: "video-top", ...state }));
    });

  await render({ overlay: true });

  const bar = host.firstElementChild as HTMLElement;
  // The effect measures against `el.offsetParent` — the same containing
  // block the CSS park/reveal resolves against — and jsdom lays nothing out,
  // so both the link (offsetParent, which jsdom always reports as `null`)
  // and the box it returns need stubbing, the same gap `fakeLayout` exists
  // to close for the band/tab measurements above.
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  const hostRect = { top: 100, bottom: 400, left: 0, right: 800, width: 800, height: 300, x: 0, y: 100, toJSON() {} };
  Object.defineProperty(host, "getBoundingClientRect", { value: () => hostRect, configurable: true });

  // A top bar's `edge` is the host's `top`; `dist = clientY - edge`. jsdom
  // implements `PointerEvent` (with clientX/clientY) well enough to dispatch
  // for real — no constructor shim needed here, unlike some other jsdom gaps
  // this harness works around. `clientX` defaults inside the stubbed host's
  // [0, 800] span; a caller overrides it to probe `inHost`.
  const moveTo = (clientY: number, clientX = 400) =>
    act(async () => {
      dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX, clientY, bubbles: true }));
      raf.flush();
    });

  // Cold start (nearEdge still `false` from the initial mount): dist 70 must
  // NOT arm. This is the step a `prev ? 96 : 48` → constant-`96` mutation
  // would fail to catch — every OTHER step below still passes against that
  // mutant, since they never probe the 48–96 band from a genuinely parked
  // state.
  await moveTo(170); // dist 70, cold
  assert.equal(bar.hasAttribute("data-revealed"), false, "70px from a PARKED start must not arm — only the narrower 48px ARM threshold applies before anything is revealed; the wider 96px is a RELEASE threshold only");

  // dist 40 is within the arm threshold vertically, but clientX 900 is
  // outside the stubbed host's [0, 800] span — `inHost` is what stops a
  // pointer over, say, the CHAT panel beside the video (desktop compact,
  // same Y range) from revealing the VIDEO's bar. Deleting `inHost` entirely
  // passes every other step in this test, since they all use clientX 400.
  await moveTo(140, 900); // dist 40, but outside the host horizontally
  assert.equal(bar.hasAttribute("data-revealed"), false, "40px vertically is in range, but x=900 is outside the host's [0,800] span — inHost must gate the reveal or a neighboring panel's pointer would arm the wrong bar's chrome");

  await moveTo(140); // dist 40 — under the 48px arm threshold, in range
  assert.equal(bar.hasAttribute("data-revealed"), true, "40px from the host's top edge, in range, arms the reveal");

  await moveTo(170); // dist 70 — past 48, but inside the wider 96px release threshold
  assert.equal(bar.hasAttribute("data-revealed"), true, "70px stays revealed: hysteresis holds it open past the (narrower) arm threshold, which is what stops the reveal/park oscillation the old zone had");

  await moveTo(220); // dist 120 — past even the release threshold
  assert.equal(bar.hasAttribute("data-revealed"), false, "120px releases — past the 96px hysteresis band");

  // PAST the host's edge: a small negative dist is the page gutter or the panel
  // gap and still arms; a large one is a NEIGHBOUR (the dock under an attached
  // video in desktop compact) and must not — without the bound, a pointer
  // anywhere over the dock would keep the video's bottom bar open, and a
  // pointer over the video would reveal the dock's row.
  await moveTo(80); // dist −20: the 12px gap + a little, still "near"
  assert.equal(bar.hasAttribute("data-revealed"), true, "20px past the edge (the gap between two panels) arms — a gutter is still near");
  await moveTo(40); // dist −60: over the neighbour above
  assert.equal(bar.hasAttribute("data-revealed"), false, "60px past the edge is over the neighbouring panel, not near this one — the lower bound releases");

  await moveTo(140); // re-arm, so the next assertion proves the GUARD clears it, not that it was already off
  assert.equal(bar.hasAttribute("data-revealed"), true, "setup: re-armed before checking the overlay/hidden guard");

  await render({ overlay: true, hidden: true });
  assert.equal(bar.hasAttribute("data-revealed"), false, "hidden wins over overlay: the effect's cleanup (F2) resets nearEdge, and the read-site guard suppresses it either way");

  await moveTo(140);
  assert.equal(bar.hasAttribute("data-revealed"), false, "and the listener is really gone, not just suppressed — the same position that armed it above does nothing once hidden");

  await act(async () => { root.unmount(); });
  host.remove();
});

// The "stuck open" case: without help, revealing the bar and then wandering
// the pointer onto the (cross-origin, hence silent) video iframe would freeze
// `nearEdge` at `true` forever, since no more `pointermove` ever arrives. The
// `pointerout` listener is the fix — verified here with a REAL relatedTarget
// (an actual <iframe>, not a mock), since that's the one signal a
// cross-origin frame still lets the parent observe.
test("entering the video iframe parks an already-revealed bar (pointerout, F1) — leaving the window does too", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const iframe = dom.window.document.createElement("iframe");
  host.appendChild(iframe);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  await act(async () => {
    root.render(React.createElement(Bar, { slot: "top", name: "video-top", overlay: true }));
  });

  const bar = host.firstElementChild as HTMLElement;
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  const hostRect = { top: 100, bottom: 400, left: 0, right: 800, width: 800, height: 300, x: 0, y: 100, toJSON() {} };
  Object.defineProperty(host, "getBoundingClientRect", { value: () => hostRect, configurable: true });

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY: 140, bubbles: true }));
    raf.flush();
  });
  assert.equal(bar.hasAttribute("data-revealed"), true, "setup: revealed, same as the arm step above");

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointerout", { relatedTarget: iframe, bubbles: true }));
  });
  assert.equal(bar.hasAttribute("data-revealed"), false, "the pointer crossing INTO the iframe (relatedTarget = the iframe element) parks the bar — without this it would stick open, since the iframe delivers no further pointermove to the parent at all");

  // Re-arm, then prove the window-leaving branch (relatedTarget null) too —
  // a distinct case from the iframe one, both handled by the same listener.
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY: 140, bubbles: true }));
    raf.flush();
  });
  assert.equal(bar.hasAttribute("data-revealed"), true, "setup: re-armed for the second branch");

  // The guard's NON-park path: an ordinary
  // element-to-element pointerout — relatedTarget is a plain Element — fires
  // constantly as the pointer crosses rows near the edge, and must NOT park.
  // A mutant that parks on ANY pointerout survived every other step here.
  const sibling = dom.window.document.createElement("div");
  host.appendChild(sibling);
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointerout", { relatedTarget: sibling, bubbles: true }));
  });
  assert.equal(bar.hasAttribute("data-revealed"), true, "a pointerout whose relatedTarget is a plain element (moving between parent-DOM elements) must NOT park — only the iframe and window-exit cases may");

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointerout", { relatedTarget: null, bubbles: true }));
  });
  assert.equal(bar.hasAttribute("data-revealed"), false, "relatedTarget null (the pointer left the window entirely) also parks — the other half of the same guard");

  await act(async () => { root.unmount(); });
  host.remove();
});

// The two `edge`/`dist` ternaries in Bar.tsx mirror slot="top" for
// slot="bottom" — untested by the test above, so a sign error in that branch
// would be invisible. StreamMetaBar (the donate-pill bar) is precisely a
// bottom overlay bar, which is why this specific slot is the money one.
test("overlay proximity reveal mirrors correctly for slot=\"bottom\" (the money bar): distance to the host's BOTTOM edge, same hysteresis", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  await act(async () => {
    root.render(React.createElement(Bar, { slot: "bottom", name: "meta", overlay: true }));
  });

  const bar = host.firstElementChild as HTMLElement;
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  const hostRect = { top: 100, bottom: 400, left: 0, right: 800, width: 800, height: 300, x: 0, y: 100, toJSON() {} };
  Object.defineProperty(host, "getBoundingClientRect", { value: () => hostRect, configurable: true });

  // A bottom bar's `edge` is the host's `bottom` (400); `dist = edge - clientY`.
  const moveTo = (clientY: number) =>
    act(async () => {
      dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY, bubbles: true }));
      raf.flush();
    });

  await moveTo(360); // dist 40 — arms
  assert.equal(bar.hasAttribute("data-revealed"), true, "40px above the host's BOTTOM edge arms the reveal");

  await moveTo(330); // dist 70 — holds via the 96px release threshold
  assert.equal(bar.hasAttribute("data-revealed"), true, "70px stays revealed — same hysteresis, mirrored edge");

  await moveTo(280); // dist 120 — releases
  assert.equal(bar.hasAttribute("data-revealed"), false, "120px releases");

  await act(async () => { root.unmount(); });
  host.remove();
});

// A host (ChatSidebar's composer bar) needs to
// sync something ELSE to Bar's own proximity reveal — the message list
// translating up under a revealed composer — without duplicating the
// pointer mechanism. `onRevealChange` is the surface. This test exercises
// BOTH mutation directions: a mutant that fires unconditionally (every
// render, or every effect run regardless of the guard) would fail the
// "no extra call while holding" and the non-overlay assertions below; a
// mutant that never fires would fail every `deepEqual` here outright.
test("onRevealChange mirrors the overlay bar's own effective reveal state — arms true, holds silent, parks false via iframe pointerout", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const iframe = dom.window.document.createElement("iframe");
  host.appendChild(iframe);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  const calls: boolean[] = [];
  const onRevealChange = (r: boolean) => { calls.push(r); };

  await act(async () => {
    root.render(React.createElement(Bar, { slot: "top", name: "video-top", overlay: true, onRevealChange }));
  });

  const bar = host.firstElementChild as HTMLElement;
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  const hostRect = { top: 100, bottom: 400, left: 0, right: 800, width: 800, height: 300, x: 0, y: 100, toJSON() {} };
  Object.defineProperty(host, "getBoundingClientRect", { value: () => hostRect, configurable: true });

  // Mount itself is a "change" (from nothing tracked to `false`) for an
  // overlay bar — announced exactly once.
  assert.deepEqual(calls, [false], "mount announces the initial (unrevealed) overlay state exactly once");
  calls.length = 0;

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY: 140, bubbles: true })); // dist 40
    raf.flush();
  });
  assert.deepEqual(calls, [true], "arming (dist 40 <= 48) fires exactly one `true`");
  calls.length = 0;

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY: 170, bubbles: true })); // dist 70, holds via hysteresis
    raf.flush();
  });
  assert.deepEqual(calls, [], "holding inside the hysteresis band is not a CHANGE in the effective boolean — no extra call, even though the underlying pointermove fired");

  await act(async () => {
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointerout", { relatedTarget: iframe, bubbles: true }));
  });
  assert.deepEqual(calls, [false], "parking via the iframe pointerout (F1's stuck-open fix) fires exactly one `false`");

  await act(async () => { root.unmount(); });
  host.remove();
});

test("onRevealChange is never called for a non-overlay bar — not once, not even with false", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  const calls: boolean[] = [];
  const onRevealChange = (r: boolean) => { calls.push(r); };

  await act(async () => {
    root.render(React.createElement(Bar, { slot: "top", name: "in-flow", onRevealChange }));
  });
  assert.deepEqual(calls, [], "mount, no overlay: zero calls");

  // Even a prop-driven `revealed=true` on a non-overlay bar must not reach
  // onRevealChange — the callback is scoped to overlay bars ENTIRELY, not
  // merely gated on the boolean it would otherwise report.
  await act(async () => {
    root.render(React.createElement(Bar, { slot: "top", name: "in-flow", revealed: true, onRevealChange }));
  });
  assert.deepEqual(calls, [], "revealed=true on a non-overlay bar still must not call onRevealChange");

  await act(async () => { root.unmount(); });
  host.remove();
});

// Neither test above feeds onRevealChange's own output back into the SAME
// Bar's `revealed` prop — they only push into a `calls` array. ChatSidebar's
// actual wiring does exactly that (`revealed={composerOpen}`, `composerOpen`
// set FROM `onRevealChange`), and `effectiveRevealed = revealed || nearEdge`
// would latch permanently true the instant that echo happened: once
// `revealed` itself became `true`, `revealed(true) || nearEdge(anything)`
// never goes back to `false`, so a real pointer retreat stops being visible.
// This probe mirrors ChatSidebar's exact pattern in miniature — the one
// shape that has to be exercised for this class of bug to be provable.
//
// Break-verified: with `effectiveRevealed = overlay && !hidden && (revealed ||
// nearEdge)` this test goes RED, with `data-revealed` stuck `"true"` after
// the retreat step below.
test("onRevealChange cannot latch when its own output feeds back into the SAME Bar's revealed prop — ChatSidebar's exact pattern", async () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);

  function Probe() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(Bar, {
      slot: "top", name: "video-top", overlay: true,
      revealed: open,
      onRevealChange: (r: boolean) => setOpen(r),
    });
  }

  await act(async () => { root.render(React.createElement(Probe)); });

  const bar = host.firstElementChild as HTMLElement;
  Object.defineProperty(bar, "offsetParent", { value: host, configurable: true });
  const hostRect = { top: 100, bottom: 400, left: 0, right: 800, width: 800, height: 300, x: 0, y: 100, toJSON() {} };
  Object.defineProperty(host, "getBoundingClientRect", { value: () => hostRect, configurable: true });

  const moveTo = (clientY: number) =>
    act(async () => {
      dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 400, clientY, bubbles: true }));
      raf.flush();
    });

  await moveTo(140); // dist 40 — arms
  assert.equal(bar.hasAttribute("data-revealed"), true, "setup: armed — onRevealChange(true) fires, the probe's `open` state becomes true, and `revealed` echoes it back on the next render");

  await moveTo(220); // dist 120 — well past the 96px release threshold
  assert.equal(bar.hasAttribute("data-revealed"), false, "retreating past release MUST clear data-revealed — under the pre-fix `revealed || nearEdge` semantics this stayed stuck \"true\" forever, because the echoed `revealed` prop alone kept the OR true regardless of what nearEdge did next");

  await act(async () => { root.unmount(); });
  host.remove();
});

test("occluded is inert + aria-hidden with no geometry change", async () => {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);

  const render = (state: { occluded?: boolean }) =>
    act(async () => {
      root.render(
        React.createElement(Bar, {
          slot: "top",
          name: "occl",
          ...state,
        }),
      );
    });

  await render({ occluded: true });

  const bar = container.firstElementChild as HTMLElement;
  assert.equal(bar.hasAttribute("inert"), true, "occluded covers the bar's controls, so they must leave the tab order");
  assert.equal(bar.getAttribute("aria-hidden"), "true");
  assert.equal(
    bar.hasAttribute("data-state"), false,
    "occluded is not hidden or overlay — the bar keeps its in-flow geometry, so the " +
    "data-state attribute `hidden` would set must be absent"
  );

  await render({ occluded: false });

  assert.equal(bar.hasAttribute("inert"), false, "occluded=false must leave no attribute behind");
  assert.equal(bar.hasAttribute("aria-hidden"), false);
  assert.equal(bar.hasAttribute("data-state"), false);

  await act(async () => { root.unmount(); });
  container.remove();
});
