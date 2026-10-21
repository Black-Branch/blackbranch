// On a computer, a window can SLIDE into the
// chat column (the phone's panel) instead of floating. A default in Settings ›
// Behavior › Windows, plus a button on each window that switches THAT window
// and remembers it. Changing the default resets every window's own choice, so
// the setting always means "windows open like this". Phones always slide; a
// page with no chat column to slide into keeps floating and shows no button.
//
// Run: node --test app/lib/chrome/windowDock.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dom, React, act, resetStorage, mountHook } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";
import { stripComments } from "../testSource.ts";

installResizeObserverStub();
const { resolveDock, useWindowDock } = await import("./windowDock.ts");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");
const { Window } = await import("@/app/components/chrome/Window");
const { createRoot } = await import("react-dom/client");

test("phones always slide, with no button", () => {
  for (const def of [null, "float", "slide"]) {
    assert.deepEqual(resolveDock({ narrow: true, hasLayer: true, saved: "float@float", def }), { presentation: "panel", toggleable: false });
  }
});

test("no chat column to slide into: floating, no button — never the full-screen fallback", () => {
  assert.deepEqual(resolveDock({ narrow: false, hasLayer: false, saved: "slide@slide", def: "slide" }), { presentation: "floating", toggleable: false });
});

test("a computer follows the default until the window is switched", () => {
  assert.deepEqual(resolveDock({ narrow: false, hasLayer: true, saved: null, def: null }), { presentation: "floating", toggleable: true }, "today's look is the default");
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: null, def: "slide" }).presentation, "panel");
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: "slide@float", def: "float" }).presentation, "panel", "the window's own choice");
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: "float@slide", def: "slide" }).presentation, "floating");
});

test("changing the default resets a window's own choice", () => {
  // Chosen under Float; the default is now Slide → the default wins.
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: "float@float", def: "slide" }).presentation, "panel");
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: "slide@slide", def: "float" }).presentation, "floating");
  assert.equal(resolveDock({ narrow: false, hasLayer: true, saved: "junk", def: "slide" }).presentation, "panel");
});

// jsdom lays nothing out, so a layer's size is set by hand.
function sizedLayer(w: number, h: number) {
  const el = dom.window.document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: w });
  Object.defineProperty(el, "offsetHeight", { value: h });
  return el;
}

test("a folded-away chat column is nowhere to slide into (the card would vanish)", async () => {
  resetStorage(); _resetWindowLayerForTests();
  registerPaneTarget("live", sizedLayer(0, 0)); setActivePane("live");
  dom.window.localStorage.setItem("chatStyle_winDock", "slide");
  const h = await mountHook(() => useWindowDock("usercard", false));
  assert.equal(h.current.presentation, "floating");
  assert.equal(h.current.dock, undefined);
  await h.unmount();
  resetStorage(); _resetWindowLayerForTests();
});

test("the hook: the button flips the window and it is remembered", async () => {
  resetStorage(); _resetWindowLayerForTests();
  const layer = sizedLayer(380, 600);
  registerPaneTarget("live", layer); setActivePane("live");
  const h = await mountHook(() => useWindowDock("modwin", false));
  assert.equal(h.current.presentation, "floating");
  assert.ok(h.current.dock, "a computer with a chat column offers the button");
  assert.equal(h.current.dock!.docked, false);
  await h.act(() => h.current.dock!.toggle());
  assert.equal(h.current.presentation, "panel");
  assert.equal(h.current.dock!.docked, true);
  await h.unmount();
  const again = await mountHook(() => useWindowDock("modwin", false));
  assert.equal(again.current.presentation, "panel", "reopening keeps the choice");
  await again.unmount();
  const other = await mountHook(() => useWindowDock("library", false));
  assert.equal(other.current.presentation, "floating", "one window's choice is not another's");
  await other.unmount();
  dom.window.localStorage.setItem("chatStyle_winDock", "slide");
  const reset = await mountHook(() => useWindowDock("modwin", false));
  assert.equal(reset.current.presentation, "panel");
  await reset.act(() => reset.current.dock!.toggle());
  assert.equal(reset.current.presentation, "floating", "a choice made under the new default sticks");
  await reset.unmount();
  const phone = await mountHook(() => useWindowDock("modwin", true));
  assert.equal(phone.current.presentation, "panel");
  assert.equal(phone.current.dock, undefined, "no button on a phone");
  await phone.unmount();
  _resetWindowLayerForTests();
  const bare = await mountHook(() => useWindowDock("modwin", false));
  assert.equal(bare.current.presentation, "floating");
  assert.equal(bare.current.dock, undefined, "nowhere to slide into");
  await bare.unmount();
  resetStorage();
});

function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}
const btn = (label: string) => dom.window.document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

test("the window's band carries the button, beside pop-out, in both shapes", () => {
  _resetWindowLayerForTests();
  let flips = 0;
  const dock = (docked: boolean) => ({ docked, toggle: () => { flips++; } });
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
  const f = mount(React.createElement(Window, { presentation: "floating", name: "Mod panel", title: "Mod panel", popoutUrl: "/mod", dock: dock(false), onClose: () => {}, children: React.createElement("div") }));
  const slide = btn("Slide into chat");
  assert.ok(slide, "floating offers Slide into chat");
  const pop = btn("Open in a new window");
  assert.ok(pop && slide!.compareDocumentPosition(pop) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "before pop-out");
  act(() => slide!.click());
  assert.equal(flips, 1);
  f.unmount();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer); setActivePane("live");
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
  const p = mount(React.createElement(Window, { presentation: "panel", kind: "task", name: "Mod panel", title: "Mod panel", dock: dock(true), onClose: () => {}, children: React.createElement("div") }));
  assert.ok(btn("Float this window"), "a slid-in window offers Float");
  assert.equal(btn("Slide into chat"), null);
  p.unmount();
  // eslint-disable-next-line react/no-children-prop -- createElement in a .ts file; WindowProps.children is required
  const none = mount(React.createElement(Window, { presentation: "floating", name: "X", title: "X", onClose: () => {}, children: React.createElement("div") }));
  assert.equal(btn("Slide into chat"), null, "no dock prop, no button");
  none.unmount();
  _resetWindowLayerForTests();
});

test("every window that floats on a computer takes its shape from useWindowDock", () => {
  const hosts: Record<string, string> = {
    "app/components/AccountCard.tsx": "account",
    "app/features/chat/ChatSidebar.tsx": "usercard",
    "app/features/moderation/ModWindow.tsx": "mod",
    "app/features/instance/AdminWindow.tsx": "admin",
    // A site plugin's window, in a tree that has the app/(owner) folder.
    ...(existsSync("app/(owner)") ? { "app/(owner)/_radio/RadioPlayer/LibraryPanel.tsx": "library" } : {}),
  };
  for (const [file, id] of Object.entries(hosts)) {
    const s = stripComments(readFileSync(file, "utf8"));
    assert.match(s, new RegExp(`useWindowDock\\("${id}", \\w+\\)`), file);
    assert.doesNotMatch(s, /\? "panel" : "floating"/, `${file} still picks by width alone`);
    assert.match(s, /dock=\{\w+\.dock\}/, `${file} never hands the button its switch`);
  }
});

test("Settings › Behavior › Windows offers the default", () => {
  const menu = stripComments(readFileSync("app/lib/settingsMenu.ts", "utf8"));
  assert.match(menu, /\{ title: "Windows", tab: "behavior", items: \[s\("winDock"\), s\("winFrom"\)\] \}/);
  const reg = stripComments(readFileSync("app/lib/settingsRegistry.ts", "utf8"));
  assert.match(reg, /winDock: E\(\{ ls: "chatStyle_winDock", prePaint: false, deviceLocal: true, behavior: true,/);
  assert.match(reg, /winDock:\s+"float"/, "Float stays the default: nobody's windows move until they choose");
});
