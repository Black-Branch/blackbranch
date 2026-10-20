// The player fold's mount lifecycle — the hook is RUN, not source-scanned.
//
// The defects this guards are ones every source scan is green over — an
// unfold that cannot transition, and a `transitionend` wait with no fallback,
// which leaves the player mounted and AUDIBLE behind a folded panel on
// Safari < 16 and Firefox < 127. A sequence of events over time is exactly
// what a scan cannot see.
//
// Run: node --test app/lib/usePlayerFold.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { React, dom, mountHook } from "./testDom.ts";
import {
  usePlayerFold,
  FOLD_ANIM_MS,
  FOLD_UNMOUNT_FALLBACK_MS,
} from "./usePlayerFold.ts";

/** jsdom implements no matchMedia; the hook asks it one question. */
function stubReducedMotion(reduce: boolean): () => void {
  const w = dom.window as unknown as { matchMedia?: unknown };
  const prev = w.matchMedia;
  w.matchMedia = (q: string) => ({ matches: reduce && q.includes("prefers-reduced-motion") });
  return () => { w.matchMedia = prev; };
}

/**
 * Mount the hook with a settable `folded`, the way StreamView drives it: the
 * fold handler calls `armFold()` and THEN flips the stored mode, so the arm and
 * the flip land in the same commit.
 */
async function mountFold() {
  let setFolded: (v: boolean) => void = () => {};
  const h = await mountHook(() => {
    const [folded, set] = React.useState(false);
    setFolded = set;
    return usePlayerFold(folded);
  });
  return { h, fold: (v: boolean) => setFolded(v) };
}

const grid = { propertyName: "grid-template-rows" };

test("the player survives the collapse and `transitionend` is what releases it", async () => {
  const restore = stubReducedMotion(false);
  const { h, fold } = await mountFold();

  assert.equal(h.current.playerMounted, false, "nothing is armed before a fold");

  await h.act(() => { h.current.armFold(); fold(true); });
  assert.equal(h.current.playerMounted, true,
    "an audible cut before the visual one is worse — the player rides the collapse");

  await h.act(() => { h.current.onRegionTransitionEnd(grid); });
  assert.equal(h.current.playerMounted, false, "the collapse ending is what unmounts it");

  await h.unmount();
  restore();
});

test("only the fold's own property, and only the fold DIRECTION, may unmount it", async () => {
  const restore = stubReducedMotion(false);
  const { h, fold } = await mountFold();

  await h.act(() => { h.current.armFold(); fold(true); });
  await h.act(() => { h.current.onRegionTransitionEnd({ propertyName: "opacity" }); });
  assert.equal(h.current.playerMounted, true,
    "some other property finishing must not be read as the collapse finishing");

  // The region transitions OPEN too (both directions animate), and that event
  // arrives with `folded` already false. It must unmount nothing.
  await h.act(() => { fold(false); });
  await h.act(() => { h.current.onRegionTransitionEnd(grid); });
  assert.equal(h.current.playerMounted, true, "the expand's own transitionend must be inert");

  await h.unmount();
  restore();
});

test("the player is released even when `transitionend` NEVER fires", async (t) => {
  // `grid-template-rows` is not interpolable in Safari < 16 or Firefox < 127:
  // the change applies in one frame and no transition event is dispatched at
  // all. Without this fallback the player stays mounted and AUDIBLE behind a
  // zero-height region — a viewer hearing a stream they believe they closed.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restore = stubReducedMotion(false);
  const { h, fold } = await mountFold();

  await h.act(() => { h.current.armFold(); fold(true); });
  assert.equal(h.current.playerMounted, true);

  await h.act(() => { t.mock.timers.tick(FOLD_ANIM_MS); });
  assert.equal(h.current.playerMounted, true,
    "the fallback must never cut a normal collapse short — it waits out the full transition first");

  await h.act(() => { t.mock.timers.tick(FOLD_UNMOUNT_FALLBACK_MS - FOLD_ANIM_MS); });
  assert.equal(h.current.playerMounted, false, "the fallback guarantees the unmount");

  await h.unmount();
  restore();
});

test("reduced motion releases the player in the same commit, waiting for nothing", async (t) => {
  // chrome.css sets `transition: none` under prefers-reduced-motion, so there
  // is no transition to ride and no event to wait for. Arming and waiting would
  // leave the player mounted for the whole fallback window.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restore = stubReducedMotion(true);
  const { h, fold } = await mountFold();

  await h.act(() => { h.current.armFold(); fold(true); });
  assert.equal(h.current.playerMounted, false, "no wait at all under reduced motion");

  await h.act(() => { t.mock.timers.tick(FOLD_UNMOUNT_FALLBACK_MS * 2); });
  assert.equal(h.current.playerMounted, false, "and nothing re-arms it later");

  await h.unmount();
  restore();
});

test("a second fold gets its own full window, not the first one's leftover timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const restore = stubReducedMotion(false);
  const { h, fold } = await mountFold();

  await h.act(() => { h.current.armFold(); fold(true); });
  await h.act(() => { t.mock.timers.tick(FOLD_ANIM_MS); });
  await h.act(() => { fold(false); });

  // Re-fold while the first fallback would still have been pending.
  await h.act(() => { h.current.armFold(); fold(true); });
  await h.act(() => { t.mock.timers.tick(FOLD_UNMOUNT_FALLBACK_MS - FOLD_ANIM_MS); });
  assert.equal(h.current.playerMounted, true,
    "the stale timer must have been cleared — otherwise this fold is cut short by the previous one's clock");

  await h.act(() => { t.mock.timers.tick(FOLD_ANIM_MS); });
  assert.equal(h.current.playerMounted, false, "…and its own fallback still fires");

  await h.unmount();
  restore();
});
