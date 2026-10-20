// Behavioural test for useOutsideClick's multi-ref form — the hook is RUN.
//
// The emote menu button must toggle closed. A press on a toggle button is a
// `mousedown` and then a `click`. When the popover's outside-click guard does
// not count the button as inside, the mousedown closes the popover and the
// click's toggle re-opens it — the button can open the picker but never close
// it. The hook's array form exists for exactly this pairing; EmotePicker uses
// it (the source scan at the end pins that).
//
// Run: node --test app/lib/useOutsideClick.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dom, mountHook, React } from "./testDom.ts";
import { useOutsideClick } from "./useOutsideClick.ts";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function mousedownOn(el: Element) {
  el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
}

/** A popover element and the button that toggles it, both in the document. */
function fixture() {
  const popover = dom.window.document.createElement("div");
  const button = dom.window.document.createElement("button");
  dom.window.document.body.append(popover, button);
  return {
    popover, button,
    cleanup: () => { popover.remove(); button.remove(); },
  };
}

test("single ref: a press on the toggle button counts as OUTSIDE — the toggle bug's mechanism", async () => {
  const f = fixture();
  let outside = 0;
  const h = await mountHook(() => {
    const ref = React.useRef<HTMLDivElement | null>(f.popover);
    useOutsideClick(ref, () => { outside += 1; }, { touch: false });
  });
  await h.act(() => { mousedownOn(f.button); });
  assert.equal(outside, 1, "documenting the mechanism: with only the popover listed, the button's mousedown dismisses");
  await h.unmount();
  f.cleanup();
});

test("popover + anchor: a press on the toggle button is INSIDE, a press elsewhere still dismisses", async () => {
  const f = fixture();
  let outside = 0;
  const h = await mountHook(() => {
    const ref = React.useRef<HTMLDivElement | null>(f.popover);
    const anchorRef = React.useRef<HTMLElement | null>(f.button);
    useOutsideClick([ref, anchorRef], () => { outside += 1; }, { touch: false });
  });
  await h.act(() => { mousedownOn(f.button); });
  assert.equal(outside, 0,
    "the button's mousedown dismissed the popover — its click then re-opens it, so the button can never close it");
  await h.act(() => { mousedownOn(f.popover); });
  assert.equal(outside, 0, "a press inside the popover must not dismiss");
  await h.act(() => { mousedownOn(dom.window.document.body); });
  assert.equal(outside, 1, "a press outside both must still dismiss");
  await h.unmount();
  f.cleanup();
});

test("EmotePicker lists its anchor in the outside-click guard", () => {
  const src = readFileSync(join(webRoot, "app/components/EmotePicker.tsx"), "utf8");
  assert.match(src.slice(-200), /<\/ComposerPopover>\s*\);\s*}\s*$/,
    "EmotePicker.tsx did not end as expected — the read is truncated, and the assertion below is vacuous");
  assert.match(stripComments(src), /useOutsideClick\(\[ref, anchorRef\], onClose, \{ escape: true, touch: false \}\)/,
    "the picker must count its toggle button as inside, or the button can open it but never close it");
});
