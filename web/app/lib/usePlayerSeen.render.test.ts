// usePlayerSeen by RUNNING it: a fake IntersectionObserver and a scripted visibilityState. Also
// pins the edge-touch rule: IO's "isIntersecting with ratio 0" (the hidden chat pane's exact
// geometry) is NOT seen.
import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook } from "./testDom.ts";
import { usePlayerSeen } from "./usePlayerSeen.ts";

type Cb = (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void;
const live = new Set<{ cb: Cb; disconnected: boolean }>();
class FakeIO {
  rec: { cb: Cb; disconnected: boolean };
  constructor(cb: Cb) { this.rec = { cb, disconnected: false }; live.add(this.rec); }
  observe() {}
  disconnect() { this.rec.disconnected = true; live.delete(this.rec); }
}
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
let vis: "visible" | "hidden" = "visible";
Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => vis });
const emit = (isIntersecting: boolean, intersectionRatio: number) => { for (const r of live) r.cb([{ isIntersecting, intersectionRatio }]); };

test("hidden page, off-screen box, edge touch — each is unseen; both clear is seen; unmount cleans up", async () => {
  const el = dom.window.document.createElement("div");
  const ref = { current: el };
  const h = await mountHook(() => usePlayerSeen(ref));
  assert.equal(h.current, true);
  await h.act(() => { vis = "hidden"; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  assert.equal(h.current, false, "hidden page");
  await h.act(() => { vis = "visible"; dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  assert.equal(h.current, true);
  await h.act(() => emit(false, 0));
  assert.equal(h.current, false, "scrolled away");
  await h.act(() => emit(true, 0));
  assert.equal(h.current, false, "an edge touch with zero area is not seen");
  await h.act(() => emit(true, 0.4));
  assert.equal(h.current, true);
  assert.equal(live.size, 1);
  await h.unmount();
  assert.equal(live.size, 0, "unmount disconnects the observer");
});
