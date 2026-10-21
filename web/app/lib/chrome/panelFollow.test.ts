// The motion primitive every panel motion shares: read where the box IS, hold
// it somewhere with the transition suppressed, release it to the stylesheet's
// `translate` transition. Extracted from PanelWindow's lift-follow so the
// drag, the snap and the content-growth follow cannot drift from it. jsdom
// lays nothing out and animates nothing, but it DOES return inline
// `translate` from getComputedStyle and reports style-attribute mutations with
// their old values — which is exactly enough to pin the write ORDER, the only
// thing that makes a FLIP a motion instead of a jump.
import test from "node:test";
import assert from "node:assert/strict";
import { dom } from "../testDom.ts";
import { currentTranslateY, currentTransformY, layoutTop, holdTranslate, releaseTranslate } from "./panelFollow.ts";

function box(translate?: string) {
  const el = dom.window.document.createElement("div");
  if (translate) el.style.translate = translate;
  dom.window.document.body.appendChild(el);
  return el;
}

/** Every distinct `translate` value the element's style attribute passed through, in order. */
async function translateHistory(el: HTMLElement, run: () => void): Promise<string[]> {
  const olds: string[] = [];
  const mo = new dom.window.MutationObserver((muts) => { for (const m of muts) olds.push(m.oldValue ?? ""); });
  mo.observe(el, { attributes: true, attributeFilter: ["style"], attributeOldValue: true });
  run();
  await Promise.resolve(); // observer delivery is a microtask
  mo.disconnect();
  const seq = [...olds, el.getAttribute("style") ?? ""].map((s) => /translate:\s*([^;]+)/.exec(s)?.[1]?.trim() ?? null);
  return seq.filter((v, i): v is string => v !== null && v !== seq[i - 1]);
}

test("currentTranslateY: none/unset → 0; reads the Y of a two-value translate", () => {
  assert.equal(currentTranslateY(box()), 0, "unset");
  assert.equal(currentTranslateY(box("none")), 0, "`none` is the keyword, not a length");
  assert.equal(currentTranslateY(box("0 -40px")), -40);
  assert.equal(currentTranslateY(box("0px 82.5px")), 82.5, "fractional values must survive — a rounded read is a one-frame nudge");
  assert.equal(currentTranslateY(box("12px")), 0, "a single value is X only");
});

test("layoutTop: rect against the layer, NET of the panel's own in-flight translate", () => {
  const layer = box();
  const panel = box("0 -40px");
  layer.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  panel.getBoundingClientRect = () => ({ top: 100 + 186.4 - 40 } as DOMRect); // where a browser would report a box laid out at 186.4 and translated −40
  // IEEE754: `100 + 186.4 - 40` is not bit-identical to `186.4` under any
  // subtraction order, so this is a tolerance check, not a strict one.
  assert.ok(Math.abs(layoutTop(panel, layer) - 186.4) < 1e-9, "the translate is subtracted back out and the fraction is kept");
});

test("holdTranslate: writes the value with the transition SUPPRESSED and leaves it suppressed", () => {
  const el = box();
  holdTranslate(el, -82.2);
  assert.equal(el.style.translate, "0 -82.2px");
  assert.equal(el.style.transitionProperty, "none", "a held value must not animate — a drag writes one per frame");
});

test("releaseTranslate: hold at `from`, THEN restore the transition, THEN write `to` — that order is the motion", async () => {
  const el = box();
  const seq = await translateHistory(el, () => releaseTranslate(el, -82, 0));
  // A zero length needs no unit — same convention the X component already
  // uses ("0", never "0px") — and it's what window.render.test.ts's
  // lift-follow fixtures assert for a release to rest.
  assert.deepEqual(seq, ["0 -82px", "0 0"], "the jump lands first (suppressed), the transition carries the rest");
  assert.equal(el.style.transitionProperty, "", "released to the stylesheet's transition");
});

test("releaseTranslate to a non-zero detent — the drag's snap to contentFit", async () => {
  const el = box("0 30px");
  const seq = await translateHistory(el, () => releaseTranslate(el, 30, 96));
  assert.deepEqual(seq, ["0 30px", "0 96px"]);
});

test("currentTransformY: reads the Y of a matrix / matrix3d / translate transform; none → 0", () => {
  const el = box();
  const at = (t: string) => { el.style.transform = t; return currentTransformY(el); };
  assert.equal(currentTransformY(box()), 0, "unset");
  assert.equal(at("none"), 0);
  assert.equal(at("matrix(1, 0, 0, 1, 0, 123.5)"), 123.5, "a browser's computed form during panel-seam-in");
  assert.equal(at("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 4,-42,0,1)"), -42, "the 3d form's ty is the 14th number");
  assert.equal(at("translateY(380px)"), 380, "jsdom hands back the inline text");
  assert.equal(at("translate(10px, 20px)"), 20);
  assert.equal(at("rotate(3deg)"), 0, "no Y translation to report");
});

test("layoutTop: immune to the panel's OWN in-flight transform (the entry slide), not only its translate", () => {
  // The ResizeObserver's initial delivery lands while panel-seam-in is still
  // sliding on `transform`; a baseline that carried the slide read the entry's
  // progress as growth and fired a follow on every open.
  const layer = box();
  const panel = box("0 -40px");
  panel.style.transform = "translateY(300px)";
  layer.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
  panel.getBoundingClientRect = () => ({ top: 100 + 186.4 - 40 + 300 } as DOMRect);
  assert.ok(Math.abs(layoutTop(panel, layer) - 186.4) < 1e-9, "translate AND transform are subtracted back out");
});
