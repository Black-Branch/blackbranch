// The key row's question: is touch the primary input? The hook answers
// Q_TOUCH_PRIMARY, false on the server, and follows a change.
//
// Run: node --test app/lib/useTouchPrimary.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";

const { Q_TOUCH_PRIMARY, Q_NARROW } = await import("./deviceQueries.ts");
const { useTouchPrimary } = await import("./useTouchPrimary.ts");
const { createRoot } = await import("react-dom/client");

test("true only for the touch-primary query, and it follows a change", () => {
  let touch = true;
  const listeners = new Set<() => void>();
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    get matches() { return q === Q_TOUCH_PRIMARY ? touch : q === Q_NARROW; },
    addEventListener(_: string, cb: () => void) { listeners.add(cb); },
    removeEventListener(_: string, cb: () => void) { listeners.delete(cb); },
  });
  const seen: boolean[] = [];
  function Probe() { seen.push(useTouchPrimary()); return null; }
  const host = dom.window.document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(React.createElement(Probe)));
  assert.equal(seen.at(-1), true, "a phone");
  touch = false;
  act(() => { for (const l of listeners) l(); });
  assert.equal(seen.at(-1), false, "a narrow window on a computer is NOT touch primary");
  act(() => root.unmount());
  assert.equal(listeners.size, 0, "unsubscribed");
});
