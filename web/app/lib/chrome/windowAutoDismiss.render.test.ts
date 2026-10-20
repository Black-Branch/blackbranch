// Timed auto-dismiss: a panel window with
// `autoDismissMs` closes itself after that long WITHOUT interaction; a pointer
// or a key inside it resets the clock; clearing the prop cancels it (an
// accepted DM stays). Used by /announce and unaccepted DMs. The close
// goes through requestClose, so the exit animates and onClose fires ONCE —
// in jsdom the 250ms animation backstop delivers it.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub } from "../testTsx.ts";

installResizeObserverStub();
const { Window } = await import("@/app/components/chrome");
const { createRoot } = await import("react-dom/client");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("./windowLayer.ts");

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function mount(autoDismissMs: number | undefined) {
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  let closes = 0;
  const render = (ms: number | undefined) => act(() => root.render(
    // eslint-disable-next-line react/no-children-prop -- this .ts file calls React.createElement directly (no JSX to nest children into); WindowProps.children is intentionally required, and tsc's createElement overload needs the literal `children` key present in the props object
    React.createElement(Window, {
      presentation: "panel", kind: "peek", name: "announce", onClose: () => { closes += 1; }, autoDismissMs: ms,
      children: React.createElement("div", null, "everyone: the stream is live"),
    }),
  ));
  render(autoDismissMs);
  const panel = () => dom.window.document.querySelector('[role="dialog"][aria-label="announce"]')! as HTMLElement;
  return { panel, render, closes: () => closes, unmount: () => { act(() => root.unmount()); layer.remove(); host.remove(); } };
}

test("autoDismissMs closes the panel after the interval, through requestClose (once)", async () => {
  const m = mount(200);
  await sleep(60);
  assert.equal(m.closes(), 0, "not before the interval");
  await sleep(700); // 200 + the 250ms exit backstop + slack
  assert.equal(m.closes(), 1, "closed exactly once");
  m.unmount();
});

test("interaction inside the panel resets the clock", async () => {
  // Timeline (ms from mount): interval 300; pointerdown at 200 re-arms → fires at 500 → the
  // 250ms exit backstop delivers onClose at ~750; without the reset it fires at 300 → onClose
  // at ~550. The check at 600 sits between the two, with act/timer overhead pushing it toward
  // the safe (later-close) edge.
  const m = mount(300);
  await sleep(200);
  act(() => { m.panel().dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
  await sleep(400); // t ≈ 600
  assert.equal(m.closes(), 0, "without the reset the close would have landed by ~550ms");
  await sleep(400); // t ≈ 1000
  assert.equal(m.closes(), 1, "and it still closes after the re-armed interval");
  m.unmount();
});

test("no autoDismissMs → the panel never closes on its own (the dark default)", async () => {
  const m = mount(undefined);
  await sleep(500);
  assert.equal(m.closes(), 0);
  m.unmount();
});

test("clearing autoDismissMs before it fires cancels it (an accepted DM stays)", async () => {
  const m = mount(200);
  await sleep(80);
  await m.render(undefined);
  await sleep(700);
  assert.equal(m.closes(), 0, "the timer was cleared with the prop");
  m.unmount();
});

// The floating fallback keeps the timer, and the host can close a window through its own close
// path (the send-to button sliding the DM window away).
function mountWith(props: Record<string, unknown>) {
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  let closes = 0;
  act(() => root.render(
    React.createElement(Window, {
      name: "dm", onClose: () => { closes += 1; }, presentation: "panel", ...props,
      children: React.createElement("div", null, "casey: hi"),
    } as Parameters<typeof Window>[0]),
  ));
  return { closes: () => closes, unmount: () => { act(() => root.unmount()); layer.remove(); host.remove(); } };
}

test("floating: autoDismissMs closes the window too (the fallback when the chat column is folded)", async () => {
  const m = mountWith({ presentation: "floating", autoDismissMs: 150 });
  await sleep(60);
  assert.equal(m.closes(), 0);
  await sleep(300);
  assert.equal(m.closes(), 1, "closed once, at once — floating has no exit animation");
  m.unmount();
});

test("closeRef: the host's handle runs the window's own close (animated on a panel), once; it empties on unmount", async () => {
  const closeRef: { current: (() => void) | null } = { current: null };
  const m = mountWith({ presentation: "panel", kind: "peek", closeRef });
  await sleep(10);
  assert.equal(typeof closeRef.current, "function", "filled while mounted");
  act(() => { closeRef.current!(); });
  assert.equal(m.closes(), 0, "a panel's close animates first (requestClose), it does not unmount at once");
  await sleep(400); // the 250ms exit backstop delivers it
  assert.equal(m.closes(), 1);
  m.unmount();
  assert.equal(closeRef.current, null, "emptied when the window goes");
});
