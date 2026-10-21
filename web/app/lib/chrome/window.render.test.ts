// What a mount can see that a source scan cannot:
// 1. ONE text slot. tabs present → a tablist renders and the title string does
//    NOT, even when both props are passed; no tabs → the title, no tablist.
// 2. dialog: portalled scrim, role="dialog", aria-modal="true", aria-label =
//    name, and the band's close button carries an accessible name.
// 3. floating: role="dialog" aria-modal="false", NO scrim, Escape (the shared
//    LIFO dismiss stack) closes it.
// 4. floating + storageKey: unmounting inside the debounce window still writes
//    geometry — without the flush-on-unmount the last move is silently lost.
// 5. dialog focuses itself on mount and restores focus on unmount.
//
// Run: node --test app/lib/chrome/window.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripCssComments } from "../testSource.ts";
import { join } from "node:path";
import { dom, React, act, resetStorage } from "../testDom.ts";
import { KB_LIFT_EVENT } from "../useViewportHeightVar.ts";
import { installResizeObserverStub } from "../testTsx.ts";

const ro = installResizeObserverStub();
// Direct file import, not the barrel "@/app/components/chrome" — the same
// precedent bar.render.test.ts and sections.render.test.ts already follow.
// (bootSequence.render.test.ts imports the barrel itself, deliberately, to
// prove that door resolves too — see testTsx.ts's directory/index case.)
const { Window } = await import("@/app/components/chrome/Window");
const { createRoot } = await import("react-dom/client");

function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, root, unmount: () => act(() => root.unmount()) };
}

const TABS = [
  { key: "formatting", label: "Formatting" },
  { key: "theme", label: "Theme" },
] as const;

test("one text slot: tabs suppress the title; no tabs shows it", () => {
  const a = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "floating", name: "Chat appearance", title: "SHOULD NOT RENDER",
      tabs: TABS, activeTab: "theme", onTab: () => {}, onClose: () => {},
      children: React.createElement("div"),
    }),
  );
  const dlg = dom.window.document.querySelector('[role="dialog"][aria-label="Chat appearance"]')!;
  assert.ok(dlg, "the floating window renders as a named non-modal dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "false");
  assert.ok(dlg.querySelector('[role="tablist"]'), "tabs render as Sections");
  assert.ok(!dlg.textContent!.includes("SHOULD NOT RENDER"),
    "the title rendered beside the sections — the band has ONE text slot");
  a.unmount();

  const b = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "floating", name: "Library", title: "Library", onClose: () => {},
      children: React.createElement("div"),
    }),
  );
  const dlg2 = dom.window.document.querySelector('[role="dialog"][aria-label="Library"]')!;
  assert.ok(!dlg2.querySelector('[role="tablist"]'), "no tabs → no tablist");
  assert.ok(dlg2.textContent!.includes("Library"), "no tabs → the title fills the slot");
  b.unmount();
});

test("dialog: portalled scrim, modal semantics, named close", () => {
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "dialog", name: "Start a poll", title: "Start a poll", onClose: () => {},
      children: React.createElement("input", { "aria-label": "Question" }),
    }),
  );
  const scrim = dom.window.document.querySelector(".chrome-scrim")!;
  assert.ok(scrim, "the dialog renders a scrim");
  assert.equal(scrim.parentElement, dom.window.document.body, "the dialog always portals to <body>");
  const dlg = scrim.querySelector('[role="dialog"]')!;
  assert.equal(dlg.getAttribute("aria-modal"), "true");
  assert.equal(dlg.getAttribute("aria-label"), "Start a poll");
  assert.ok(dlg.querySelector('button[aria-label="Close"]'), "the band renders a named close control");
  m.unmount();
});

test("floating: Escape closes via the shared dismiss stack; no scrim", () => {
  let closed = 0;
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "floating", name: "User", title: "User", onClose: () => { closed += 1; },
      children: React.createElement("div"),
    }),
  );
  assert.equal(dom.window.document.querySelector(".chrome-scrim"), null, "floating has no scrim");
  act(() => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  assert.equal(closed, 1, "Escape did not reach the window through the dismiss stack");
  m.unmount();
});

test("floating + storageKey: unmount flushes the pending geometry write", () => {
  resetStorage();
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "floating", name: "Library", title: "Library",
      storageKey: "win-test-geom", defaultSize: { w: 300, h: 400 }, onClose: () => {},
      children: React.createElement("div"),
    }),
  );
  m.unmount();
  const raw = dom.window.localStorage.getItem("win-test-geom");
  assert.ok(raw, "closing inside the debounce window discarded the write — the flush-on-unmount is gone");
});

test("dialog focuses itself on mount and restores on unmount", () => {
  const btn = dom.window.document.createElement("button");
  dom.window.document.body.appendChild(btn);
  btn.focus();
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "dialog", name: "Add a space", title: "Add a space", onClose: () => {},
      children: React.createElement("div"),
    }),
  );
  const dlg = dom.window.document.querySelector('[role="dialog"][aria-modal="true"]')!;
  assert.ok(dlg.contains(dom.window.document.activeElement), "focus did not move into the dialog");
  m.unmount();
  assert.ok(dom.window.document.activeElement === btn, "focus was not restored to the opener");
  btn.remove();
});

test("floating: a re-render must not jump the dismiss stack ahead of a layer pushed above it", async () => {
  let closedA = 0;
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "floating", name: "User", title: "User", onClose: () => { closedA += 1; },
      children: React.createElement("div"),
    }),
  );

  // Simulate a dialog opened above this (already-mounted) floating card —
  // AccountCard/PollComposer register the same way, via pushDismissLayer.
  const { pushDismissLayer } = await import("@/app/lib/chrome/dismissStack");
  let dialogClosed = 0;
  const pop = pushDismissLayer(() => { dialogClosed += 1; });

  // Re-render the SAME mounted root with a brand-new inline onClose arrow —
  // this is what a chat-driven re-render (a new message) does to every
  // floating card's props, same identity churn as ChatSidebar's user card.
  let closedB = 0;
  act(() => {
    m.root.render(
      // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
      React.createElement(Window, {
        presentation: "floating", name: "User", title: "User", onClose: () => { closedB += 1; },
        children: React.createElement("div"),
      }),
    );
  });

  act(() => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });

  assert.equal(dialogClosed, 1,
    "a re-rendered floating window must not jump the dismiss stack — Escape belongs to the layer above it");
  assert.equal(closedA, 0, "the floating window's original onClose fired though it is not the top layer");
  assert.equal(closedB, 0, "the floating window's post-re-render onClose fired though it is not the top layer");

  pop();
  m.unmount();
});

test("a minWidth floor widens the render but never the saved geometry", async () => {
  resetStorage();
  const { loadGeom } = await import("@/app/lib/chrome/panelGeometryStore");
  const a = mount(
    // eslint-disable-next-line react/no-children-prop -- createElement needs the literal children key (file precedent)
    React.createElement(Window, {
      presentation: "floating", name: "Account", title: "Account", onClose: () => {},
      storageKey: "t-floor", defaultSize: { w: 384, h: 560 }, minWidth: 632,
      children: React.createElement("div"),
    }),
  );
  const dlg = dom.window.document.querySelector('[role="dialog"][aria-label="Account"]') as HTMLElement;
  assert.equal(dlg.style.width, "632px", "the floor applies at render time");
  a.unmount(); // flushes the debounced persister
  const saved = loadGeom("t-floor");
  assert.ok(saved, "geometry was persisted");
  assert.equal(saved!.w, 384, "the persisted width is the USER's, not the floor's");
});

test("page: modal full-viewport window — inert shell, no grips, no popout, band intact", () => {
  const shell = dom.window.document.createElement("div");
  shell.id = "app-shell";
  dom.window.document.body.appendChild(shell);
  const a = mount(
    // eslint-disable-next-line react/no-children-prop -- createElement needs the literal children key (file precedent)
    React.createElement(Window, {
      presentation: "page", name: "Library", title: "Library",
      onClose: () => {}, popoutUrl: "/popout/user?x=1",
      children: React.createElement("div"),
    }),
  );
  const dlg = dom.window.document.querySelector('[role="dialog"][aria-label="Library"]') as HTMLElement;
  assert.ok(dlg, "renders as a named dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "true", "page is MODAL");
  assert.ok(dlg.className.includes("chrome-window-page"));
  assert.ok(!dom.window.document.querySelector(".chrome-scrim"), "no scrim — the page IS the surface");
  assert.ok(!dlg.querySelector(".chrome-window-grip"), "no resize grips");
  assert.ok(!dlg.querySelector('[aria-label="Open in a new window"]'), "⧉ never renders on page");
  assert.ok(shell.hasAttribute("inert"), "the app shell is inert while the page is up");
  a.unmount();
  assert.ok(!shell.hasAttribute("inert"), "released on unmount");
  shell.remove();
});

test("page close requests are back-first: Escape pops in-card depth before closing", async () => {
  let backs = 0, closes = 0;
  const stack = [{ key: "profile", title: "" }, { key: "appearance", title: "Chat appearance" }];
  const a = mount(
    // eslint-disable-next-line react/no-children-prop -- createElement needs the literal children key (file precedent)
    React.createElement(Window, {
      presentation: "page", name: "Account", title: "Account",
      stack, onBack: () => { backs += 1; }, onClose: () => { closes += 1; },
      children: React.createElement("div"),
    }),
  );
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(backs, 1, "depth > 1: the request pops a page");
  assert.equal(closes, 0, "…and does NOT close the window");
  a.unmount();

  // A lower dismiss layer, registered before the page window mounts (the
  // ordinary stacking order for anything the page window is opened over).
  const { pushDismissLayer } = await import("@/app/lib/chrome/dismissStack");
  let lowerDismissed = 0;
  const popLower = pushDismissLayer(() => { lowerDismissed += 1; });

  const b = mount(
    // eslint-disable-next-line react/no-children-prop -- createElement needs the literal children key (file precedent)
    React.createElement(Window, {
      presentation: "page", name: "Account", title: "Account",
      stack: [{ key: "profile", title: "" }], onBack: () => { backs += 1; }, onClose: () => { closes += 1; },
      children: React.createElement("div"),
    }),
  );
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(backs, 1, "depth 1: no page to pop");
  assert.equal(closes, 1, "…so the window closes");
  b.unmount();

  // The page window's dismiss layer must be gone the instant it unmounts —
  // React's unmount cleanup runs before the next popstate/Escape, which is
  // what the sentinel's rapid-double-back correctness relies on
  // (pageBackSentinel.ts). If the layer survived, this Escape would call the
  // (now stale) onClose/onBack again instead of reaching the layer below.
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(lowerDismissed, 1, "unmount released the page window's layer — Escape now reaches the layer below it");
  assert.equal(backs, 1, "no further back fired after unmount");
  assert.equal(closes, 1, "no further close fired after unmount");
  popLower();
});

// ── presentation="panel" ─────────────────────────────────────────────────────
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } =
  await import("./windowLayer.ts");

function paneFixture() {
  // The real shape: an outer pane holding the body wrapper (content siblings
  // + the clipped layer, WindowLayerTarget's element) AND the composer as a
  // SIBLING of that wrapper, OUTSIDE it — ChatSidebar's live-pane geometry
  // (the `relative flex-1` body wrapper, then AutomodHoldBar/the composer Bar
  // as later siblings of the SAME pane). acquireSiblingInert only inerts
  // `layer`'s own siblings within `wrap` (scrollSib) — never anything outside
  // `wrap` — so `composer` living outside `wrap` is what makes "the composer
  // stays live" a checkable property instead of a fixture with nothing outside
  // the wrapper to fail to inert.
  const pane = dom.window.document.createElement("div");
  const wrap = dom.window.document.createElement("div");
  const scrollSib = dom.window.document.createElement("div");
  const layer = dom.window.document.createElement("div");
  const composer = dom.window.document.createElement("div");
  wrap.append(scrollSib, layer);
  pane.append(wrap, composer);
  dom.window.document.body.append(pane);
  return { pane, wrap, scrollSib, layer, composer };
}

/** Mount a panel window; returns the dialog element + the host handle. */
function mountPanel(extra: Record<string, unknown> = {}) {
  const name = (extra.name as string) ?? "bram";
  const m = mount(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name, onClose: () => {},
      children: React.createElement("div"),
      ...extra,
    }),
  );
  const dlg = dom.window.document.querySelector(`[role="dialog"][aria-label="${name}"]`)! as HTMLElement;
  return { ...m, dlg };
}

test("panel: portals into the ACTIVE pane's layer; peek is non-modal", () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const { dlg, unmount } = mountPanel();
  assert.ok(layer.contains(dlg), "the panel window must render INSIDE the layer, not on <body>");
  assert.ok(dlg.className.includes("chrome-window-panel"));
  assert.equal(dlg.getAttribute("aria-modal"), "false", "peek is non-modal");
  unmount();
});

test("panel: captures its pane at MOUNT — an active-pane change does not move it", () => {
  _resetWindowLayerForTests();
  const a = paneFixture(); const b = paneFixture();
  registerPaneTarget("live", a.layer);
  registerPaneTarget("matrix", b.layer);
  setActivePane("live");
  const { dlg, unmount } = mountPanel();
  setActivePane("matrix"); // pager swipe after open
  assert.ok(a.layer.contains(dlg), "the window stays with the pane it opened in");
  assert.ok(!b.layer.contains(dlg));
  unmount();
});

test("panel task: covered body-region SIBLINGS go inert (counted); layer parent's outside stays live", () => {
  _resetWindowLayerForTests();
  const { scrollSib, layer, composer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const w1 = mountPanel({ kind: "task", name: "Settings" });
  assert.ok(scrollSib.hasAttribute("inert"), "task covers the region — siblings inert");
  // The acceptance property: the composer sits OUTSIDE the body
  // wrapper, so acquireSiblingInert (scoped to `layer`'s own parent) must
  // never reach it — while the task window is open, not just before/after.
  assert.ok(!composer.hasAttribute("inert"), "the composer is outside the body wrapper and must stay live");
  const w2 = mountPanel({ kind: "task", name: "Mod tools" });
  assert.ok(!composer.hasAttribute("inert"), "still live with two stacked task windows");
  w1.unmount();
  assert.ok(scrollSib.hasAttribute("inert"), "counted: one task window still open");
  assert.ok(!composer.hasAttribute("inert"), "still live with one task window open");
  w2.unmount();
  assert.ok(!scrollSib.hasAttribute("inert"), "released at zero");
  assert.ok(!composer.hasAttribute("inert"), "never touched at any point");
});

test("panel peek: siblings stay LIVE (the peek exists for the content behind it)", () => {
  _resetWindowLayerForTests();
  const { scrollSib, layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const { unmount } = mountPanel();
  assert.ok(!scrollSib.hasAttribute("inert"));
  unmount();
});

test("panel fallback with NO layer: task renders the page shape, peek the sheet shape", () => {
  _resetWindowLayerForTests(); // no targets anywhere (community page, popout)
  const t = mountPanel({ kind: "task", name: "Settings" });
  assert.ok(t.dlg.className.includes("chrome-window-page"), "task degrades to full-viewport page");
  assert.equal(t.dlg.getAttribute("aria-modal"), "true");
  t.unmount();
  const p = mountPanel();
  assert.ok(p.dlg.className.includes("chrome-window-sheet"), "peek degrades to the viewport bottom sheet");
  assert.equal(p.dlg.getAttribute("aria-modal"), "false");
  p.unmount();
});

// The bottom-sheet shape, reached via peek's no-registered-layer FALLBACK
// rather than a dedicated presentation.
test("panel peek fallback: non-modal bottom surface — shell NOT inert, no scrim, no grips, ⧉ when popoutUrl is given, Escape closes", () => {
  _resetWindowLayerForTests(); // no registered pane target — exercises the fallback path
  // The sheet exists FOR the content behind it (live-preview chat,
  // the peeked-over chat), so modality would defeat it — the inert assertion
  // here is the load-bearing one.
  const shell = dom.window.document.createElement("div");
  shell.id = "app-shell";
  dom.window.document.body.appendChild(shell);
  let closes = 0;
  const a = mount(
    // eslint-disable-next-line react/no-children-prop -- createElement needs the literal children key (file precedent)
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name: "bram", title: "bram",
      onClose: () => { closes += 1; }, popoutUrl: "/popout/user?x=1",
      children: React.createElement("div"),
    }),
  );
  const dlg = dom.window.document.querySelector('[role="dialog"][aria-label="bram"]') as HTMLElement;
  assert.ok(dlg, "renders as a named dialog");
  assert.equal(dlg.getAttribute("aria-modal"), "false", "peek fallback is NON-modal");
  assert.ok(dlg.className.includes("chrome-window-sheet"));
  assert.ok(!shell.hasAttribute("inert"), "the app shell stays LIVE under the peek fallback");
  assert.ok(!dom.window.document.querySelector(".chrome-scrim"), "no scrim — the content behind is the point");
  assert.ok(!dlg.querySelector(".chrome-window-grip"), "no resize grips");
  assert.ok(dlg.querySelector('[aria-label="Open in a new window"]'),
    "⧉ renders on the peek fallback when popoutUrl is given — a panel accepts the prop, so it must render it");
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(closes, 1, "Escape closes through the shared dismiss stack");
  a.unmount();
  shell.remove();
});

test("panel: ⧉ renders when popoutUrl is given, opens it, and is absent without it; floating-only props stay ignored", () => {
  // A prop a shell ACCEPTS is a prop it must RENDER: a PanelWindow that
  // ignored popoutUrl would show the button on desktop (floating) only.
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const opened: unknown[][] = [];
  const realOpen = dom.window.open;
  dom.window.open = ((...args: unknown[]) => { opened.push(args); return null; }) as typeof dom.window.open;
  try {
    const { dlg, unmount } = mountPanel({ popoutUrl: "/u/bram", storageKey: "nope", fitHeight: true, defaultSize: { w: 720, h: 640 } });
    const btn = dlg.querySelector('[aria-label="Open in a new window"]') as HTMLElement | null;
    assert.ok(btn, "⧉ renders on a panel when popoutUrl is given");
    assert.ok(!dlg.querySelector(".chrome-window-grip"), "storageKey/fitHeight are still floating-only: no grips on a panel");
    act(() => { btn!.click(); });
    assert.equal(opened.length, 1, "clicking ⧉ opens exactly one window");
    const [url, winName, features] = opened[0] ?? [];
    assert.equal(url, "/u/bram", "…at the popoutUrl");
    assert.equal(winName, "bb-panel-/u/bram", "…under the same window name FloatingWindow uses, so a re-click focuses it");
    assert.match(String(features), /width=720,height=640/, "sized from defaultSize — a panel has no dragged box");
    unmount();
    const bare = mountPanel({ name: "plain" });
    assert.ok(!bare.dlg.querySelector('[aria-label="Open in a new window"]'), "no popoutUrl → no ⧉ (the assertion above is not vacuous)");
    bare.unmount();
  } finally {
    dom.window.open = realOpen;
  }
});

test("panel exit mirrors entry: ✕ plays panel-out, THEN closes; animationend seals it", () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  let closed = 0;
  const { dlg, unmount } = mountPanel({ onClose: () => { closed++; } });
  // Entry's own animationend must NOT close the window. `{ bubbles: true }`
  // matches the real CSS AnimationEvent (bubbles by spec) — React's onX
  // delegation needs the native bubble phase to reach the portal container's
  // listener; a plain `new Event(...)` defaults to bubbles:false and would
  // never arrive, which is not how a real animationend fires.
  act(() => { dlg.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
  assert.equal(closed, 0, "entry animationend is not a close request");
  const x = dlg.querySelector('[aria-label="Close"]') as HTMLElement;
  act(() => { x.click(); });
  assert.equal(closed, 0, "close request first plays the exit — onClose not yet");
  assert.equal(dlg.getAttribute("data-closing"), "", "the exit animation is armed");
  act(() => { dlg.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
  assert.equal(closed, 1, "exit animationend delivers the close");
  // onClose is a callback, not a self-unmount — the real close still has to
  // be unmounted like every other test here, or its leftover dialog (same
  // default name "bram") shadows the NEXT test's querySelector.
  unmount();
});

test("panel exit: a SECOND close request during the exit closes immediately", () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  let closed = 0;
  const { dlg, unmount } = mountPanel({ onClose: () => { closed++; } });
  const x = dlg.querySelector('[aria-label="Close"]') as HTMLElement;
  act(() => { x.click(); });
  act(() => { x.click(); });
  assert.equal(closed, 1, "an impatient second ✕ must not strand a zombie window");
  // The first click's own CSS animation is still running on the (still
  // mounted) node — its animationend lands AFTER the second click already
  // delivered the close immediately. That must not deliver onClose again.
  act(() => { dlg.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
  assert.equal(closed, 1, "the first click's animationend must not deliver onClose a second time");
  unmount();
});

// ── the keyboard survives a panel open (keepFocus's law) ─────────────────────
// "Chat interactions do not cost you the keyboard" (keepFocus.ts) — every chat
// button preserves composer focus, so the panel's own mount-grab must not
// defeat it one layer up: focus yanked → phone keyboard closed → the lifted
// layout (composer, layer, panel) dropped mid-entry, detached from the typing
// bar.

test("panel: opening while the user is TYPING leaves focus (and the keyboard) in the composer — peek and task", () => {
  _resetWindowLayerForTests();
  const { layer, composer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const field = dom.window.document.createElement("textarea");
  composer.appendChild(field);
  field.focus();
  assert.ok(dom.window.document.activeElement === field, "precondition: the composer field holds focus");
  const peek = mountPanel();
  assert.ok(dom.window.document.activeElement === field,
    "a peek exists FOR the surface behind it — stealing focus closes the phone keyboard and drops the whole lifted layout");
  peek.unmount();
  assert.ok(dom.window.document.activeElement === field, "no restore-yank either: focus never moved, so close must not move it");
  const task = mountPanel({ kind: "task", name: "Settings" });
  assert.ok(dom.window.document.activeElement === field,
    "the composer is LIVE under a task window by design — a task must not cost the keyboard either");
  task.unmount();
  field.remove();
});

test("panel: with NO editable focused, the grab still runs — Escape flows and screen readers keep their entry point", () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  (dom.window.document.activeElement as HTMLElement | null)?.blur?.();
  const { dlg, unmount } = mountPanel();
  assert.ok(dom.window.document.activeElement === dlg, "cold open: the panel takes focus, floating's exact behavior");
  unmount();
});

// ── the K term ───────────────────────────────────────────────────────────────
// With the keyboard up the shell is PINNED and the chat panel TRANSLATES up by
// K (useKeyboardLift, which publishes --kb-lift — behavior-pinned in
// useKeyboardLift.render.test.ts). The layer must subtract K from its top
// edge or "100%" means the full pinned pane instead of the visible space —
// keyboard-up cards would escape the chat area. jsdom computes no layout, so
// the CSS half is pinned as source.

test("chrome.css: the layer's box never animates — the ceiling is a TOKEN the panel subtracts, and the motion is the panel's own translate", () => {
  // The first version put the ceiling calc on the layer's `top` with
  // `transition: top`. `top` is a LAYOUT property: that transition ran on the
  // main thread and the panel's `max-height: 100%` re-resolved against it
  // every frame — a card relaid out 11 times in 200ms (prod trace, 4x
  // throttle) while the lift itself ran on the compositor — jittery resizing
  // when the keyboard opens over a card. Now the
  // calc is --pane-ceiling on the layer, the panel subtracts it, and a change
  // is ONE layout jump that PanelWindow's lift-follow eases as `translate`.
  const css = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "chrome.css"), "utf8");
  const layerAt = css.indexOf(".chrome-window-layer {");
  assert.notEqual(layerAt, -1, "vacuity anchor: the layer block exists");
  const layer = stripCssComments(css.slice(layerAt, css.indexOf("}", layerAt)));
  assert.match(layer, /--pane-ceiling: max\(0px, calc\(var\(--kb-lift\) - var\(--pane-ceiling-rise\) - var\(--pane-chrome-above\)\)\);/,
    "the ceiling must be declared on the layer as a token, floored at 0, over all three chrome tokens");
  assert.doesNotMatch(layer, /\btop:/, "the layer's `top` is back — a layout property that animates is the jitter returning");
  assert.doesNotMatch(layer, /transition/, "nothing on the layer may transition: its box must never change for the keyboard");
  const panelAt = css.indexOf(".chrome-window-panel {");
  const panel = stripCssComments(css.slice(panelAt, css.indexOf("}", panelAt)));
  assert.match(panel, /max-height: calc\(100% - var\(--pane-ceiling\)\);/, "the panel subtracts the ceiling from its OWN bound");
  assert.match(panel, /transition: translate var\(--anim-default\) var\(--anim-ease\);/,
    "the lift-follow's curve — the same token curve as the lift and the ramp, so the three move as one");
  assert.doesNotMatch(panel, /transition: transform/, "`transform` belongs to panel-seam-in/out — a transition on it would fight their fill");
  assert.match(css, /\.chrome-window-panel\[data-kind="task"\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/,
    "task subtracts it from its height the same way");
  // The SHRINK hold: top-anchored AT the ceiling and uncapped, so the box
  // keeps its height and the layer clips it at the composer's edge.
  assert.match(css, /\.chrome-window-panel\[data-lifting\] \{ top: var\(--pane-ceiling\); bottom: auto; max-height: none; \}/,
    "the hold rule: without it a shrink clips the card's own content in the same frame");
  assert.match(css, /\.chrome-window-panel\[data-lifting\]:is\(\[data-kind="task"\], \[data-detent="cap"\], \[data-detent="free"\], \[data-drag\]\) \{ height: 100%; \}/,
    "every cap-height box (a held task, the cap detent, a parked box, mid-gesture) is held at the full pane height it had");
  assert.match(css, /\.chrome-window-panel \{ transition: none; \}/,
    "reduced motion must strip the panel's transition like every other chrome transition");
  assert.doesNotMatch(css, /\.chrome-window-layer \{ transition: none; \}/,
    "a reduced-motion override for a layer transition that no longer exists means one came back");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(css, /\}\s*\}\s*$/, "vacuity anchor: chrome.css's real tail (reduced-motion block close)");
});

test("the panel fills its layer — the top reserve is GONE, the layer's ceiling does that job", () => {
  // No `--panel-top-inset` reserve: with the layer's ceiling on the video
  // column's own edge, a reserve would just be a gap — with the tab bar
  // hidden the panel goes all the way to the video panel's lower bar. The
  // band is visible because the panel STOPS at the ceiling, not because a
  // strip is held back below it.
  const css = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "chrome.css"), "utf8");
  const panelAt = css.indexOf(".chrome-window-panel {");
  assert.notEqual(panelAt, -1, "vacuity anchor: the panel block exists");
  const block = css.slice(panelAt, css.indexOf("}", panelAt));
  // Comments stripped before the negative assertion — the block's own comment
  // NAMES the retired token to explain why it went, and a raw scan would read
  // that prose as the declaration returning (the house's own gate-vs-comment
  // lesson, in reverse).
  const decls = stripCssComments(block);
  assert.match(decls, /max-height: calc\(100% - var\(--pane-ceiling\)\);/, "peek must fill its layer up to the ceiling");
  assert.doesNotMatch(decls, /--panel-top-inset/, "the reserve is back — it is a gap, not a fix");
  assert.match(css, /\.chrome-window-panel\[data-kind="task"\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/,
    "task must fill its layer up to the ceiling too");
  // The thing that ACTUALLY keeps the band visible, pinned here so removing it
  // cannot be mistaken for removing the reserve.
  const layerAt = css.indexOf(".chrome-window-layer {");
  const layer = css.slice(layerAt, css.indexOf("}", layerAt));
  assert.match(layer, /--pane-ceiling: max\(0px, calc\(var\(--kb-lift\) - var\(--pane-ceiling-rise\) - var\(--pane-chrome-above\)\)\);/,
    "the ceiling is what places the band; without it a filled panel goes under the video column again");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(css, /\}\s*\}\s*$/, "vacuity anchor: chrome.css's real tail (reduced-motion block close)");
});

test("the ceiling is only correct because the BODY scrolls under a band that cannot shrink", () => {
  // Lowering the ceiling only helps if the overflow it creates scrolls INSIDE
  // the panel. Three declarations make that true, and each reads as redundant
  // on its own: the band is `flex: none` (so it never shrinks away under its
  // own content), the body is the one scroll container, and `min-block-size: 0`
  // defeats a flex item's automatic CONTENT-sized minimum — without it the body
  // refuses to shrink and the panel overflows its bound instead of scrolling.
  const css = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "chrome.css"), "utf8");
  const bodyAt = css.indexOf(".chrome-window-panel .chrome-window-body {");
  assert.notEqual(bodyAt, -1, "vacuity anchor: the panel-body block exists");
  const body = css.slice(bodyAt, css.indexOf("}", bodyAt));
  assert.match(body, /min-block-size: 0;/, "without this the body sizes to its CONTENT and the capped panel overflows instead of scrolling");
  assert.match(body, /overflow-y: auto;/, "the body is the panel's one scroll container");
  assert.match(css, /\.chrome-window-grab \{ flex: none;/, "the band must not be able to shrink away under its own content");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(css, /\}\s*\}\s*$/, "vacuity anchor: chrome.css's real tail (reduced-motion block close)");
});

test("the panel's focus grab must not let the browser scroll to reveal it", () => {
  // Without preventScroll, a keyboard-CLOSED open would bounce up and pull
  // back down — worst for kind=task. At focus
  // time the panel sits at translateY(100%), BELOW its layer and clipped: a
  // transformed child extends a scroll container's scrollable area, so a bare
  // focus() makes the browser scroll ancestors to reveal it (overflow:hidden
  // boxes included — useViewportHeightVar's commit() documents the same
  // mechanism for the pinned root). The entry animation then plays against
  // that offset, the panel overshoots its rest position, and the scroll
  // clamps back when the translate collapses. Keyboard-OPEN opens do not
  // do this because the grab stands down while typing — the asymmetry that
  // identifies it.
  const src = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "Window.tsx"), "utf8");
  const panelAt = src.indexOf("function PanelWindow");
  assert.notEqual(panelAt, -1, "vacuity anchor: PanelWindow exists");
  const body = src.slice(panelAt);
  assert.match(body, /panel\.focus\(\{ preventScroll: true \}\)/,
    "the panel's focus() lost preventScroll — the open bounces again");
  assert.match(body, /if \(target\) target\.scrollTop = 0;/,
    "the layer scroll clamp is gone — a browser ignoring preventScroll leaves the layer scrolled");
  // The OTHER two focus() calls in this file (floating, dialog) are windows
  // that are on-screen when focused, so they legitimately keep plain focus().
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /\}\s*$/, "vacuity anchor: Window.tsx's real tail");
});

test("the band's Back and Close keep the keyboard (closing a window must not cost it)", () => {
  // With the keyboard up, closing the card must not close the keyboard — the ✕
  // must not take focus off the composer. Both band controls are
  // pressed mid-typing on a phone; keepFocus is coarse-pointer-gated inside,
  // so desktop click behavior is untouched.
  const src = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "Window.tsx"), "utf8");
  assert.match(src, /label="Back" onClick=\{onBack\} onMouseDown=\{keepFocus\}/,
    "Back lost keepFocus");
  assert.match(src, /label="Close" onClick=\{onClose\} onMouseDown=\{keepFocus\}/,
    "Close lost keepFocus — closing a window mid-typing drops the keyboard and the whole lifted layout");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(src, /\}\s*$/, "vacuity anchor: Window.tsx's real tail");
});

test("the keyboard law reaches the window-opening triggers: avatar button and Library", () => {
  // "Opening a window must not cost the keyboard" — the panel's own grab
  // stands down (tests above), but the TRIGGER buttons blur the composer
  // before the window even mounts unless they keepFocus. The avatar button
  // (opening the account card) is the main case.
  const WEB = join(import.meta.dirname, "..", "..");
  const menu = readFileSync(join(WEB, "components", "UserMenu.tsx"), "utf8");
  const btnAt = menu.indexOf("onClick={toggle}");
  assert.notEqual(btnAt, -1, "vacuity anchor: the avatar trigger exists");
  assert.match(menu.slice(btnAt, btnAt + 900), /onMouseDown=\{keepFocus\}/,
    "the avatar button lost keepFocus — tapping it mid-typing closes the keyboard and rides the account card down");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(menu, /<\/>\s*\);\s*\}\s*$/, "vacuity anchor: UserMenu's real tail");
  // The radio's Library triggers are a site plugin's (app/(owner)/), in a tree that has it.
  if (!existsSync(join(WEB, "(owner)"))) return;
  const np = readFileSync(join(WEB, "(owner)", "_radio", "RadioPlayer", "NowPlaying.tsx"), "utf8");
  const libButtons = np.match(/onClick=\{p\.onOpenPlaylist\} onMouseDown=\{keepFocus\}/g) ?? [];
  assert.equal(libButtons.length, 2, "both Library triggers keep the keyboard");
  assert.match(np, /<\/div>\s*\);\s*\}\s*$/, "vacuity anchor: NowPlaying's real tail");
});

// ── entry-height freeze ──────────────────────────────────────────────────────
// panel-seam-in is translateY(100%) → 0, and a percentage translate resolves
// against the panel's OWN height — so async content landing mid-entry (the
// user card's profile fetch) would resize the content-fit peek and re-target
// the slide's start point: one slide, then an instant second slide to the
// corrected height. The first-frame height is pinned until the entry's own
// animationend.

test("panel entry: height is FROZEN at first-frame height until the entry animation ends", () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  // jsdom computes no layout — offsetHeight reads 0 there, and 0 (a hidden
  // ancestor in a real browser) skips the freeze. Stub the measure so the
  // mount sees a real first-frame height; the finally restores it.
  const proto = dom.window.HTMLElement.prototype;
  const realOffsetHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 252 });
  try {
    const { dlg, unmount } = mountPanel();
    assert.equal(dlg.style.height, "252px",
      "the entry animation must run on frozen first-frame geometry — any height change re-targets its % translate");
    // A DESCENDANT's animationend must not release early: animationend
    // bubbles, and the panel's body hosts its own animations (the card's
    // spinner, shimmer skeletons).
    const body = dlg.querySelector(".chrome-window-body")! as HTMLElement;
    act(() => { body.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
    assert.equal(dlg.style.height, "252px", "a child's animationend leaves the freeze in place");
    assert.equal(dlg.dataset.entered, undefined, "…and the panel is not ENTERED yet — usePanelDrag refuses a press until it is");
    act(() => { dlg.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
    assert.equal(dlg.style.height, "",
      "the entry's own animationend releases — content growth after settle is FOLLOWED (the effect below), not a pop");
    assert.equal(dlg.dataset.entered, "",
      "the same release marks the panel entered: a press mid-slide would re-target panel-seam-in's percentage base");
    unmount();
  } finally {
    Object.defineProperty(proto, "offsetHeight", realOffsetHeight);
  }
});

test("panel: the freeze HOLDS through an exit — panel-seam-out reads the same % base", async () => {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const proto = dom.window.HTMLElement.prototype;
  const realOffsetHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight")!;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 252 });
  try {
    let closed = 0;
    let resolveDelivered: (() => void) | undefined;
    const delivered = new Promise<void>((r) => { resolveDelivered = r; });
    const { dlg, unmount } = mountPanel({ onClose: () => { closed++; resolveDelivered?.(); } });
    const x = dlg.querySelector('[aria-label="Close"]') as HTMLElement;
    // Close DURING entry: arming panel-seam-out cancels panel-seam-in, so the
    // entry's animationend never fires in a real browser — only the freeze's
    // backstop timer can still reach the release, mid-exit. It must refuse:
    // the exit's % translate reads the same height, and releasing now would
    // re-create the stutter on the way out.
    act(() => { x.click(); });
    assert.equal(dlg.style.height, "252px", "a close request does not release the freeze");
    // Real timers, deterministic order: the freeze backstop was armed at
    // mount, the close backstop at the click — same constant, armed in that
    // order — so once the close backstop has DELIVERED, the freeze backstop
    // has already fired and been refused. This await is the vacuity anchor:
    // if the timers never ran, `delivered` never resolves and this test
    // hangs loudly instead of passing over a hole.
    await delivered;
    assert.equal(closed, 1);
    assert.equal(dlg.style.height, "252px",
      "the backstop's release was refused while closing — exit geometry stays frozen");
    unmount();
  } finally {
    Object.defineProperty(proto, "offsetHeight", realOffsetHeight);
  }
});

// ── lift-follow: the resize must not jitter ──────────────────────────────────
// The ceiling lands in ONE layout at the K commit (chrome.css, --pane-ceiling)
// and PanelWindow turns the panel's resulting jump into a translate that the
// stylesheet eases to 0. jsdom lays nothing out, so the panel's RECT is stubbed
// per anchoring state — resting (bottom-anchored, capped) vs held (top-anchored
// at the ceiling) — the way a browser would report it: layout top PLUS the
// panel's own inline translate (the lift-follow subtracts that back out; it
// reads fractional rects because offsetTop rounds). The layer's rect sits at 0.
// The style writes are read back through a MutationObserver with
// attributeOldValue, the only way to see the INTERMEDIATE write (the jump) as
// well as the final one (the release).

function liftFixture() {
  _resetWindowLayerForTests();
  const { layer } = paneFixture();
  registerPaneTarget("live", layer);
  setActivePane("live");
  const { dlg, unmount } = mountPanel();
  const top = { rest: 0, held: 0 };
  const inlineTranslateY = () => parseFloat(dlg.style.translate.split(/\s+/)[1] ?? "0") || 0;
  const rectAt = (y: number) => ({ top: y, bottom: y, left: 0, right: 0, width: 0, height: 0, x: 0, y, toJSON() { return this; } }) as DOMRect;
  dlg.getBoundingClientRect = () => rectAt((dlg.hasAttribute("data-lifting") ? top.held : top.rest) + inlineTranslateY());
  // The layer's rect carries a real HEIGHT too: usePanelDrag reads the cap
  // from it, never from clientHeight, which rounds (509.8px is a real layer height).
  layer.getBoundingClientRect = () => Object.assign(rectAt(0), { height: 500 });
  const history: string[] = [];
  const mo = new dom.window.MutationObserver((muts) => {
    for (const m of muts) history.push(m.oldValue ?? "");
  });
  mo.observe(dlg, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  const lift = (phase: "before" | "after", k: number) =>
    layer.dispatchEvent(new dom.window.CustomEvent(KB_LIFT_EVENT, { bubbles: true, detail: { phase, k } }));
  /** One K commit: the box's layout top reads `from` before the write and `to` after. */
  const commit = async (from: Partial<typeof top>, to: Partial<typeof top>, k: number) => {
    Object.assign(top, from); lift("before", k);
    Object.assign(top, to); lift("after", k);
    await Promise.resolve(); // the observer delivers as a microtask
  };
  /** The sequence of distinct `translate` values the panel's style went through. */
  const translates = () => {
    if (!history.length) return []; // nothing was written since reset(): the current style is stale, not a write
    const seq = [...history, dlg.getAttribute("style") ?? ""]
      .map((st) => /translate:\s*([^;]+)/.exec(st)?.[1]?.trim() ?? null);
    return seq.filter((v, i): v is string => v !== null && v !== seq[i - 1]);
  };
  const reset = () => { history.length = 0; };
  const transitionEnd = (el: Element, propertyName: string) =>
    el.dispatchEvent(Object.assign(new dom.window.Event("transitionend", { bubbles: true }), { propertyName }));
  /** Run every live ResizeObserver callback (the content-growth follow's) and
   *  let the style observer deliver. */
  const fire = async () => { act(() => { ro.fire(); }); await Promise.resolve(); };
  return { dlg, layer, top, commit, fire, translates, reset, transitionEnd, unmount: () => { mo.disconnect(); unmount(); } };
}

test("lift-follow: a SHRINK is one layout jump turned into a translate — and the box is HELD at the ceiling until its own transitionend", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 104 }, { rest: 186, held: 186 }, 300);
    assert.deepEqual(f.translates(), ["0 -82px", "0 0"],
      "translated back by exactly the jump with the transition suppressed, then released to the stylesheet's transition");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "a shrink holds the box top-anchored at the ceiling");
    assert.equal(f.dlg.style.transitionProperty, "", "the suppression must not outlive the jump — the release IS the motion");
    // transitionend BUBBLES: a descendant's translate ending must not release the hold.
    const body = f.dlg.querySelector(".chrome-window-body")! as HTMLElement;
    f.transitionEnd(body, "translate");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "a child's transitionend leaves the hold in place");
    f.transitionEnd(f.dlg, "opacity");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "the panel's own transition on another property leaves it too");
    f.transitionEnd(f.dlg, "translate");
    assert.ok(!f.dlg.hasAttribute("data-lifting"),
      "the panel's own translate ending releases the hold — the resting rule resumes at the same clip edge");
  } finally { f.unmount(); }
});

test("lift-follow: a GROW keeps the resting anchor — translate only, no hold", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 186 }, { rest: 104 }, 0);
    assert.deepEqual(f.translates(), ["0 82px", "0 0"]);
    assert.ok(!f.dlg.hasAttribute("data-lifting"), "the resting box already overhangs the layer's bottom on a grow — nothing to hold");
  } finally { f.unmount(); }
});

test("lift-follow: a commit landing MID-FLIGHT retargets from the live translate, never from 0", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 104 }, { rest: 186, held: 186 }, 300);
    // Mid-flight: the stylesheet transition is at −40 of its −82 → 0 travel.
    // jsdom's computed style IS the inline value — the same read the retarget
    // makes through getComputedStyle in a browser, where it is interpolated.
    f.dlg.style.translate = "0 -40px";
    await Promise.resolve();
    f.reset();
    // The settle correction: K grows by 40 → the ceiling, and the held top, come down 40 more.
    await f.commit({ held: 186 }, { held: 226 }, 340);
    assert.deepEqual(f.translates(), ["0 -40px", "0 -80px", "0 0"],
      "start = the current −40 plus the new −40 jump; a restart from 0 would snap the panel 40px and re-ease");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "a further shrink keeps the hold");
  } finally { f.unmount(); }
});

test("lift-follow: the keyboard LEAVING while held drops the hold BEFORE measuring, so the resting top is what it reads", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 104 }, { rest: 186, held: 186 }, 300);
    f.reset();
    // K → 0: the held top would read 0 (top-anchored at a 0 ceiling) — the
    // wrong anchor; the resting top is 104.
    await f.commit({ held: 186 }, { held: 0, rest: 104 }, 0);
    assert.ok(!f.dlg.hasAttribute("data-lifting"), "a grow ends the hold");
    assert.deepEqual(f.translates(), ["0 0", "0 82px", "0 0"],
      "186 → 104 measured at REST (+82), not 186 → 0 against the stale top anchor (+186)");
  } finally { f.unmount(); }
});

test("lift-follow: a lift that does not move the box writes nothing and disturbs nothing in flight", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 104 }, { rest: 104 }, 120); // uncapped small card: the ceiling never reached it
    assert.deepEqual(f.translates(), [], "no jump, no translate");
    assert.ok(!f.dlg.hasAttribute("data-lifting"));
    await f.commit({ rest: 104 }, { rest: 186, held: 186 }, 300);
    f.reset();
    await f.commit({ held: 186 }, { held: 186 }, 300); // a repeat commit at the same ceiling
    assert.deepEqual(f.translates(), [], "an unchanged box mid-hold must not restart the transition");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "and must not drop the hold — dropping it mid-flight opens a seam gap");
  } finally { f.unmount(); }
});

test("lift-follow: another host's lift — an element that does not contain the panel — is ignored", async () => {
  const f = liftFixture();
  try {
    const other = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(other);
    f.top.rest = 104;
    other.dispatchEvent(new dom.window.CustomEvent(KB_LIFT_EVENT, { bubbles: true, detail: { phase: "before", k: 300 } }));
    f.top.rest = 186; f.top.held = 186;
    other.dispatchEvent(new dom.window.CustomEvent(KB_LIFT_EVENT, { bubbles: true, detail: { phase: "after", k: 300 } }));
    await Promise.resolve();
    assert.deepEqual(f.translates(), [], "a lift elsewhere in the document must not move a panel it did not move");
    assert.ok(!f.dlg.hasAttribute("data-lifting"));
    other.remove();
  } finally { f.unmount(); }
});

test("lift-follow: with no transitionend (reduced motion), the backstop releases the hold", async () => {
  const f = liftFixture();
  try {
    await f.commit({ rest: 104 }, { rest: 186, held: 186 }, 300);
    assert.ok(f.dlg.hasAttribute("data-lifting"));
    await new Promise((r) => setTimeout(r, 300)); // PANEL_ANIM_BACKSTOP_MS (250) + margin
    assert.ok(!f.dlg.hasAttribute("data-lifting"),
      "reduced motion has no transition and so no transitionend — the hold must not outlive the (instant) motion");
  } finally { f.unmount(); }
});

// ── L2 handle CSS + the lift-follow ↔ drag interplay ─────────────────────────

test("chrome.css: the panel's handle arbitrates horizontally by CSS, and every held box is cap height", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "..", "components", "chrome", "chrome.css"), "utf8");
  assert.match(css, /\.chrome-window-panel > \.chrome-window-grab \{ touch-action: pan-x; \}/,
    "pan-x: horizontal pans stay native and chain to the pager; vertical is claimed by pointer capture — no gesture-race code");
  assert.match(css, /\.chrome-window-grabber \{[^}]*background: var\(--color-edge\);/,
    "the pill is PAINTED — a drag surface whose only affordance is invisible is a secret; --color-edge is the token a hairline rule uses");
  assert.match(css, /\.chrome-window-panel\[data-drag\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/,
    "the gesture's box is the cap box — the ONE scalar (translate) moves it; nothing lays out per frame");
  assert.match(css, /\.chrome-window-panel\[data-detent="cap"\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/,
    "resting at the cap after a snap: the detent box");
  assert.match(css, /\.chrome-window-panel\[data-detent="free"\] \{ height: calc\(100% - var\(--pane-ceiling\)\); \}/,
    "parked below contentFit (L2.1): still the cap box — its translate is its position, so the box must not change under it");
  assert.match(css, /\.chrome-window-panel\[data-lifting\]:is\(\[data-kind="task"\], \[data-detent="cap"\], \[data-detent="free"\], \[data-drag\]\) \{ height: 100%; \}/,
    "a keyboard shrink holds EVERY cap-height box at the full pane height — a held box that shrank with the new cap would open a seam gap");
  // vacuity anchor — the END of the file, so a truncated read cannot pass
  assert.match(css, /\}\s*\}\s*$/, "vacuity anchor: chrome.css's real tail (reduced-motion block close)");
});

test("lift-follow releases to the DRAG's pending detent while a snap is in flight — never to 0 blindly", async () => {
  // The keyboard commits inside the 200ms after a release: the lift-follow
  // retargets from the live translate, and must head for where the DRAG is
  // going (contentFit, recomputed against the new cap), or the drag's settle
  // would then jump the box from the cap to contentFit.
  const f = liftFixture();
  try {
    f.layer.style.setProperty("--pane-ceiling", "0px"); // the layer's rect (height 500) is the cap's source
    const grab = f.dlg.querySelector(".chrome-window-grab")! as HTMLElement;
    // The RESTING box is 380 tall → the press remembers it → fit = 500 − 380 =
    // 120 with a 0 ceiling. In the cap box (mid-gesture) it reads 500, which is
    // exactly why the hook remembers the resting one instead of measuring.
    Object.defineProperty(f.dlg, "offsetHeight", {
      configurable: true,
      get: () => (f.dlg.hasAttribute("data-drag") || f.dlg.dataset.detent === "cap" ? 500 : 380),
    });
    const p = (type: string, clientY: number) => act(() => { grab.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, bubbles: true })); });
    // A real release: press, move a little, pause (no flick), let go → pending detent = contentFit.
    p("pointerdown", 400); p("pointermove", 385);
    await new Promise((r) => setTimeout(r, 100));
    p("pointermove", 385); p("pointerup", 385);
    assert.ok(f.dlg.hasAttribute("data-drag"), "setup: the snap to contentFit is in flight");
    f.reset();
    // Now the keyboard: the ceiling rises 60 → the cap shrinks by 60 → contentFit's translate is now 60. The held (cap) box's layout top goes 0 → 60.
    f.layer.style.setProperty("--pane-ceiling", "60px");
    await f.commit({ rest: 0, held: 0 }, { rest: 60, held: 60 }, 300);
    await Promise.resolve();
    assert.equal(f.dlg.style.translate, "0 60px",
      "released to the drag's pending detent recomputed against the new cap (120 − 60), not to 0");
  } finally { f.unmount(); }
});

test("lift-follow on a PARKED box (L2.1) keeps its VISIBLE HEIGHT — the box rides the pane, and the keyboard never buries a repositioned window", async () => {
  // A window parked below contentFit has no resting rule of its own: its
  // translate IS its position. Across a K commit the one thing worth keeping
  // is how much of it shows above the composer — the composer is what the user
  // parked it against. So `restTranslate` for a parked box is
  // `capH_now − visibleH`, and since the cap shrinks by exactly the ceiling's
  // rise, that lands on the same pane-relative spot the box already occupies:
  // from and to coincide and the lift carries it with no motion of its own.
  const f = liftFixture();
  try {
    f.layer.style.setProperty("--pane-ceiling", "0px");
    const grab = f.dlg.querySelector(".chrome-window-grab")! as HTMLElement;
    Object.defineProperty(f.dlg, "offsetHeight", {
      configurable: true,
      get: () => (f.dlg.hasAttribute("data-drag") || f.dlg.dataset.detent === "cap" || f.dlg.dataset.detent === "free" ? 500 : 380),
    });
    const p = (type: string, clientY: number) => act(() => { grab.dispatchEvent(new dom.window.PointerEvent(type, { pointerId: 1, button: 0, clientY, bubbles: true })); });
    // Park: press at rest (fit = 120), pull 100px below contentFit, pause, let go → 220, with 280px showing.
    p("pointerdown", 400); p("pointermove", 500);
    await new Promise((r) => setTimeout(r, 100));
    p("pointermove", 500); p("pointerup", 500);
    assert.equal(f.dlg.dataset.detent, "free", "setup: parked");
    assert.equal(f.dlg.style.translate, "0 220px");
    f.reset();
    // SHRINK: the ceiling rises 60 → the cap is 440. The cap box's layout top goes 0 → 60.
    f.layer.style.setProperty("--pane-ceiling", "60px");
    await f.commit({ rest: 0, held: 0 }, { rest: 60, held: 60 }, 300);
    assert.equal(f.dlg.style.translate, "0 160px", "440 − 280: the same 280px showing, at the same place on the pane (220 − 60)");
    assert.ok(f.dlg.hasAttribute("data-lifting"), "a shrink holds the box at the full pane height like every cap-height box");
    await new Promise((r) => setTimeout(r, 300)); // from = to: no transitionend can come; the backstop releases the hold
    assert.ok(!f.dlg.hasAttribute("data-lifting"));
    assert.equal(f.dlg.dataset.detent, "free", "still parked");
    assert.equal(f.dlg.style.translate, "0 160px");
    // GROW: the keyboard leaves → the cap is 500 again; the same 280px showing means 220 again.
    f.reset();
    f.layer.style.setProperty("--pane-ceiling", "0px");
    await f.commit({ rest: 60 }, { rest: 0 }, 0);
    assert.equal(f.dlg.style.translate, "0 220px", "500 − 280");
    assert.ok(!f.dlg.hasAttribute("data-lifting"), "a grow holds nothing");
    // A pane too short for the parked height: the box sits at the cap (translate 0) — it cannot show more than the pane has.
    f.reset();
    f.layer.style.setProperty("--pane-ceiling", "300px");
    await f.commit({ rest: 0, held: 0 }, { rest: 300, held: 300 }, 600);
    assert.equal(f.dlg.style.translate, "0 0", "max(0, 200 − 280): clamped at the cap");
    assert.equal(f.dlg.dataset.detent, "free", "the attribute stays — at 0 a parked box and the cap detent are the same region");
  } finally { f.unmount(); }
});

// ── content growth follows ("growth always wins") ────────────────────────────
// Content growth is the box getting TALLER *and* its top RISING — both. The
// follow reads the panel's layer-relative layout TOP through `liftFixture`'s
// rect stub (`top.rest`, the stub the lift-follow tests drive) and the box's
// height through `offsetHeight`. Either signal alone is the PANE moving: a
// box bound to the layer grows when the layer grows at the bottom (top
// unchanged), and a content-fit box's top rises when the composer gains a
// row (height unchanged) — neither is followed.

/** The box's height, driven per test (jsdom lays nothing out). */
function stubHeight(el: HTMLElement, initial: number) {
  let h = initial;
  Object.defineProperty(el, "offsetHeight", { configurable: true, get: () => h });
  return (next: number) => { h = next; };
}

test("content growth at rest is followed: the taller box is translated back and eased up on the stylesheet transition", async () => {
  // A content-fit peek whose content grows (the user card's mod tools
  // appearing). Bottom-anchored, so the box's top moves UP by the growth; the
  // follow translates it back down and releases — the same grow path the
  // keyboard leaving takes, so the composer seam never opens (the overhang is
  // clipped by the layer).
  const f = liftFixture();
  try {
    const setH = stubHeight(f.dlg, 380);
    f.top.rest = 120;
    await f.fire();   // baseline: the first observation only records where the box is
    f.reset();
    setH(480);        // 100px of content: the box is taller…
    f.top.rest = 20;  // …and its top rose by 100
    await f.fire();
    assert.deepEqual(f.translates(), ["0 100px", "0 0"], "translated back by how far the top moved, then released to 0");
  } finally { f.unmount(); }
});

test("the composer GAINING a row moves a content-fit box's top up with its height unchanged — the pane moved, no follow", async () => {
  // The layer's bottom is the composer's top; a new wrapped row pushes it up
  // and the bottom-anchored box with it, in the same frame as everything
  // else in the pane. Following it would detach the panel's motion from the
  // composer's.
  const f = liftFixture();
  try {
    stubHeight(f.dlg, 380);
    f.top.rest = 120;
    await f.fire();
    f.reset();
    f.top.rest = 100; // pushed up 20px, same height
    await f.fire();
    assert.deepEqual(f.translates(), [], "a rise without growth is the composer, not content");
  } finally { f.unmount(); }
});

test("a baseline taken mid-entry does not carry panel-seam-in's slide — the ResizeObserver's initial delivery is not growth", async () => {
  // The effect baselines one frame after mount, while the entry is still
  // sliding on `transform`; the observer's initial delivery lands a frame or
  // two later, further along the slide. A top read that carried the slide
  // read that progress as growth and fired a follow on every open.
  // layoutTop subtracts the panel's own transform.
  const f = liftFixture();
  try {
    const setH = stubHeight(f.dlg, 380);
    const layoutRect = f.dlg.getBoundingClientRect;
    // Mid-entry: the rect sits 300px below the layout top, and the computed transform says so.
    f.dlg.style.transform = "translateY(300px)";
    f.dlg.getBoundingClientRect = () => { const r = layoutRect(); return { ...r, top: r.top + 300 } as DOMRect; };
    f.top.rest = 120;
    await f.fire(); // the initial delivery
    f.reset();
    f.dlg.style.transform = "";          // the slide ended
    f.dlg.getBoundingClientRect = layoutRect;
    await f.fire();
    assert.deepEqual(f.translates(), [], "the entry's progress is not growth");
    f.reset();
    setH(480);
    f.top.rest = 20;
    await f.fire();
    assert.deepEqual(f.translates(), ["0 100px", "0 0"], "and the baseline was right: real growth afterwards is followed by exactly the growth");
  } finally { f.unmount(); }
});

test("layer growth at the BOTTOM (the composer losing a row) does not move a bound box's top — no follow", async () => {
  // A task, the cap detent, or a peek whose content exceeds the cap: the box
  // is bound to the layer, so it grows with it. Its TOP does not move, and a
  // height-based follow bounced it for an edge that never went anywhere.
  const f = liftFixture();
  try {
    // The box's HEIGHT is what changes here; its top does not. (jsdom lays
    // nothing out, so the height a height-based follow would have read has to
    // be stubbed for this test to be able to tell the two apart.)
    let h = 380;
    Object.defineProperty(f.dlg, "offsetHeight", { configurable: true, get: () => h });
    f.top.rest = 120;
    await f.fire();
    f.reset();
    h = 480;        // the layer grew 100px at the bottom and the bound box grew with it…
    await f.fire(); // …and its top is exactly where it was
    assert.deepEqual(f.translates(), [], "a height-based follow translated the box down 100 and eased it back — a bounce for an edge that never moved");
    assert.ok(ro.observed.includes(f.layer),
      "the LAYER is observed alongside the panel — a layer resize that does not resize the panel still has to refresh the baseline");
  } finally { f.unmount(); }
});

test("content growth is NOT followed while a translate is in flight, mid-gesture, or while the keyboard holds the box", async () => {
  const f = liftFixture();
  try {
    f.top.rest = 120;
    await f.fire();
    f.dlg.style.translate = "0 -40px"; // a lift-follow release is easing
    await Promise.resolve();
    f.reset();
    f.top.rest = 20;
    await f.fire();
    assert.deepEqual(f.translates(), [], "a second FLIP on top of one in flight would double the motion — the lift-follow already moved this box");
    f.dlg.style.translate = "0 0";
    f.dlg.dataset.drag = "";
    await Promise.resolve();
    f.reset();
    f.top.rest = -60;
    await f.fire();
    assert.deepEqual(f.translates(), [], "mid-gesture the box is the cap box — its height is the finger's business");
    delete f.dlg.dataset.drag;
    f.dlg.dataset.lifting = "";
    await Promise.resolve();
    f.reset();
    f.top.held = -140; // held, so the rect stub reads top.held
    await f.fire();
    assert.deepEqual(f.translates(), [], "the keyboard's hold owns the box until its transition ends");
  } finally { f.unmount(); }
});

test("a SHRINK is a plain relayout — the hold rule governs growth, and a content-fit box has no old height left to hold", async () => {
  const f = liftFixture();
  try {
    f.top.rest = 20;
    await f.fire();
    f.reset();
    f.top.rest = 120; // the top came back DOWN: the box got shorter
    await f.fire();
    assert.deepEqual(f.translates(), []);
  } finally { f.unmount(); }
});

// ── The focused window, a kept Tab cycle, focus back ──

test("floating: Escape closes the window that holds focus, not the newest one", () => {
  const closed: string[] = [];
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file: children travels in the props object
  const mk = (n: string) => React.createElement(Window, {
    presentation: "floating", name: n, title: n, onClose: () => { closed.push(n); },
    children: React.createElement("button", { type: "button", "data-in": n }, n),
  });
  const a = mount(mk("Older"));
  const b = mount(mk("Newer"));
  const btnA = dom.window.document.querySelector<HTMLButtonElement>('[data-in="Older"]')!;
  act(() => { btnA.focus(); });
  act(() => {
    dom.window.document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.deepEqual(closed, ["Older"], "Escape closed a window the viewer was not in");
  // Focus outside every window: the newest closes, as before.
  act(() => { (dom.window.document.activeElement as HTMLElement | null)?.blur(); dom.window.document.body.focus(); });
  act(() => {
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.deepEqual(closed.slice(1), ["Newer"]);
  b.unmount();
  a.unmount();
});

test("floating: Tab wraps inside the window while it holds focus; the opener gets focus back on close", () => {
  const opener = dom.window.document.createElement("button");
  dom.window.document.body.appendChild(opener);
  opener.focus();
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file: children travels in the props object
  const m = mount(React.createElement(Window, {
    presentation: "floating", name: "Trap", title: "Trap", onClose: () => {},
    children: React.createElement("div", null,
      React.createElement("button", { type: "button", id: "first-in" }, "a"),
      React.createElement("button", { type: "button", id: "last-in" }, "b")),
  }));
  const dlg = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Trap"]')!;
  assert.ok(dlg.contains(dom.window.document.activeElement), "focus moved into the window on open");
  // jsdom gives every element an empty layout; give the two buttons a box so they count as focusable.
  const items = Array.from(dlg.querySelectorAll<HTMLElement>("button, [tabindex]")).filter((el) => el.getAttribute("tabindex") !== "-1");
  for (const el of items) el.getClientRects = () => [{}] as unknown as DOMRectList;
  const last = items[items.length - 1]!;
  act(() => { last.focus(); });
  const ev = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => { last.dispatchEvent(ev); });
  assert.equal(ev.defaultPrevented, true, "Tab from the last control did not stay in the window");
  assert.equal(dom.window.document.activeElement, items[0], "Tab from the last control goes to the first");
  m.unmount();
  assert.equal(dom.window.document.activeElement, opener, "the opener did not get focus back");
  opener.remove();
});
