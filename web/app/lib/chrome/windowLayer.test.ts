// The window-layer registry: panes register
// their body-region target elements; the active pane decides where a panel
// window opens. Module-level store, dismiss-stack house pattern — pure,
// node-tested, no React.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerPaneTarget, setActivePane, getActiveTarget, _resetWindowLayerForTests,
} from "./windowLayer.ts";

// Elements only need identity here.
const el = () => ({}) as unknown as HTMLElement;

beforeEach(() => _resetWindowLayerForTests());

test("no active pane → null; active pane with no target → null", () => {
  assert.equal(getActiveTarget(), null);
  setActivePane("live");
  assert.equal(getActiveTarget(), null, "an unregistered active pane must not resolve");
});

test("the active pane's element resolves; other panes' elements do not leak", () => {
  const live = el(); const matrix = el();
  registerPaneTarget("live", live);
  registerPaneTarget("matrix", matrix);
  setActivePane("live");
  assert.equal(getActiveTarget(), live);
  setActivePane("matrix");
  assert.equal(getActiveTarget(), matrix);
  setActivePane(null);
  assert.equal(getActiveTarget(), null);
});

test("re-registration replaces, and a STALE unregister is a no-op (StrictMode)", () => {
  const a = el(); const b = el();
  const offA = registerPaneTarget("live", a);
  registerPaneTarget("live", b); // remount claimed the pane
  setActivePane("live");
  assert.equal(getActiveTarget(), b, "last registration wins");
  offA(); // the OLD mount's cleanup fires late — must not evict b
  assert.equal(getActiveTarget(), b, "a stale unregister must not clear a newer claim");
});

test("a current unregister clears its pane", () => {
  const a = el();
  const off = registerPaneTarget("live", a);
  setActivePane("live");
  off();
  assert.equal(getActiveTarget(), null);
});
