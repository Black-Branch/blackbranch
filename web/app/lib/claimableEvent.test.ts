// The Gift button in a POPPED-OUT user card. The pop-out is its own document
// with no UserMenu, so the `bb:open-support` event has no host there, and the
// card's onClose() is `window.close()`. The gift panel lives in the window that
// OPENED the pop-out, so an unclaimed event may be offered to it — and the card
// closes only when SOME window actually took it.
//
// Run: node --test app/lib/claimableEvent.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";
import { dom } from "./testDom.ts";
import { stripComments } from "./testSource.ts";

const { dispatchClaimable, claimEvent } = await import("./claimableEvent.ts");

const HERE = dirname(fileURLToPath(import.meta.url));

/** A second, same-origin window — a real separate realm, like a pop-out's opener. */
function makeOpener() {
  const opener = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://site.test/" }).window;
  let focused = 0;
  opener.focus = () => { focused++; };
  return { opener, focusCount: () => focused };
}

function setOpener(value: unknown) {
  Object.defineProperty(dom.window, "opener", { value, configurable: true, writable: true });
}

test("unclaimed here + orOpener: the opener's host claims it, gets the detail, and is focused", () => {
  const { opener, focusCount } = makeOpener();
  const seen: unknown[] = [];
  opener.addEventListener("bb:open-support", (e) => {
    claimEvent(e);
    seen.push((e as CustomEvent).detail);
  });
  setOpener(opener);
  try {
    const claimed = dispatchClaimable("bb:open-support", { giftUsername: "@x:site.test" }, { orOpener: true });
    assert.equal(claimed, true, "the opener claimed it, so the pop-out may close");
    assert.deepEqual(seen, [{ giftUsername: "@x:site.test" }]);
    assert.equal(focusCount(), 1, "the opener was not brought forward — the gift panel opens out of sight");
  } finally {
    setOpener(null);
  }
});

test("claimed HERE: the opener is never asked (no double panel)", () => {
  const { opener, focusCount } = makeOpener();
  let openerSaw = 0;
  opener.addEventListener("bb:open-support", (e) => { openerSaw++; claimEvent(e); });
  const here = (e: Event) => claimEvent(e);
  dom.window.addEventListener("bb:open-support", here);
  setOpener(opener);
  try {
    assert.equal(dispatchClaimable("bb:open-support", {}, { orOpener: true }), true);
    assert.equal(openerSaw, 0);
    assert.equal(focusCount(), 0);
  } finally {
    dom.window.removeEventListener("bb:open-support", here);
    setOpener(null);
  }
});

test("nobody claims it anywhere: reports unclaimed, so the pop-out stays open", () => {
  const { opener, focusCount } = makeOpener();
  setOpener(opener);
  try {
    assert.equal(dispatchClaimable("bb:open-support", {}, { orOpener: true }), false);
    assert.equal(focusCount(), 0, "an opener that took nothing must not steal focus");
  } finally {
    setOpener(null);
  }
  assert.equal(dispatchClaimable("bb:open-support", {}, { orOpener: true }), false, "no opener at all");
});

test("a cross-origin or closed opener reports unclaimed instead of throwing", () => {
  setOpener({ get closed() { return false; }, get dispatchEvent(): never { throw new DOMException("Blocked", "SecurityError"); } });
  try {
    assert.equal(dispatchClaimable("bb:open-support", {}, { orOpener: true }), false);
  } finally {
    setOpener(null);
  }
  const { opener } = makeOpener();
  opener.addEventListener("bb:open-support", (e) => claimEvent(e));
  Object.defineProperty(opener, "closed", { value: true, configurable: true });
  setOpener(opener);
  try {
    assert.equal(dispatchClaimable("bb:open-support", {}, { orOpener: true }), false);
  } finally {
    setOpener(null);
  }
});

test("without orOpener the opener is never consulted — the fallback is opt-in", () => {
  const { opener } = makeOpener();
  opener.addEventListener("bb:open-support", (e) => claimEvent(e));
  setOpener(opener);
  try {
    assert.equal(dispatchClaimable("bb:open-support", {}), false);
  } finally {
    setOpener(null);
  }
});

test("UserCard's Gift button asks the opener and closes ONLY when a window claimed it", () => {
  const code = stripComments(readFileSync(join(HERE, "../components/UserCard.tsx"), "utf8"));
  assert.match(
    code,
    /if\s*\(\s*dispatchClaimable\(\s*"bb:open-support",\s*\{\s*giftUsername:\s*msg\.matrixId\s*\},\s*\{\s*orOpener:\s*true\s*\}\s*\)\s*\)\s*onClose\(\);/,
    "the Gift button no longer closes conditionally on a claim — in a pop-out an unconditional onClose() is window.close()",
  );
});
