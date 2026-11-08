// The one first-run prompt slot: among prompts wanting it in the same tick the
// earlier in the order holds it, a holder keeps it until dismissed, and after a
// dismissal nobody shows for the rest of the page load. RUN through React, not
// scanned.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/nudgeSlot.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "./testDom.ts";
import { useNudgeSlot, _resetNudgeSlotForTests, type NudgeId } from "./nudgeSlot.ts";

const { createRoot } = await import("react-dom/client");

type Wants = Partial<Record<NudgeId, boolean>>;

/** One probe per id in ONE root, so their effects run in the same commit. */
function mountProbes(initial: Wants) {
  const shown: Partial<Record<NudgeId, boolean>> = {};
  function Probe({ id, wants }: { id: NudgeId; wants: boolean }) {
    shown[id] = useNudgeSlot(id, wants);
    return null;
  }
  const root = createRoot(dom.window.document.createElement("div"));
  const render = (w: Wants) => {
    // A probe no longer rendered holds nothing: drop its last answer.
    for (const id of Object.keys(shown) as NudgeId[]) if (!(id in w)) delete shown[id];
    return act(async () => {
      root.render(React.createElement(React.Fragment, null,
        ...(Object.keys(w) as NudgeId[]).map((id) => React.createElement(Probe, { key: id, id, wants: !!w[id] }))));
    });
  };
  return {
    shown,
    render,
    start: () => render(initial),
    unmount: () => act(async () => { root.unmount(); }),
  };
}

const holders = (s: Partial<Record<NudgeId, boolean>>) => (Object.keys(s) as NudgeId[]).filter((k) => s[k]);

beforeEach(() => _resetNudgeSlotForTests());

test("same tick: secure-account beats pwa-install", async () => {
  // Mounted in the reverse of the order: the order decides, not who asked first in the commit.
  const m = mountProbes({ "help-desk": true, "pwa-install": true, "secure-account": true });
  await m.start();
  assert.deepEqual(holders(m.shown), ["secure-account"]);
  await m.unmount();
});

test("a later wanter waits", async () => {
  const m = mountProbes({ "pwa-install": true, "secure-account": false });
  await m.start();
  assert.deepEqual(holders(m.shown), ["pwa-install"]);
  // secure-account is earlier in the order, but pwa-install is already shown: no pre-emption.
  await m.render({ "pwa-install": true, "secure-account": true });
  assert.deepEqual(holders(m.shown), ["pwa-install"]);
  await m.unmount();
});

test("after dismiss nobody shows this load", async () => {
  const m = mountProbes({ "secure-account": true, "pwa-install": true });
  await m.start();
  assert.deepEqual(holders(m.shown), ["secure-account"]);
  // The holder stops wanting (its ✕): the one waiting does NOT take over.
  await m.render({ "secure-account": false, "pwa-install": true });
  assert.deepEqual(holders(m.shown), []);
  // Nor does one that starts wanting afterwards.
  await m.render({ "secure-account": false, "pwa-install": true, "help-desk": true });
  assert.deepEqual(holders(m.shown), []);
  await m.unmount();
});

test("a lone wanter gets the slot; a new page load (the reset) opens it again", async () => {
  const m = mountProbes({ "help-desk": true });
  await m.start();
  assert.deepEqual(holders(m.shown), ["help-desk"]);
  await m.render({ "help-desk": false });
  assert.deepEqual(holders(m.shown), []);
  await m.unmount();
  _resetNudgeSlotForTests();
  const again = mountProbes({ "pwa-install": true });
  await again.start();
  assert.deepEqual(holders(again.shown), ["pwa-install"]);
  await again.unmount();
});

test("unmounting the holder is a dismissal", async () => {
  const m = mountProbes({ "secure-account": true, "pwa-install": true });
  await m.start();
  assert.deepEqual(holders(m.shown), ["secure-account"]);
  await m.render({ "pwa-install": true });
  assert.deepEqual(holders(m.shown), []);
  await m.unmount();
});
