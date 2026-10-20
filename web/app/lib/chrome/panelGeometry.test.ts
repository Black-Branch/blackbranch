// Tests for the pure Window geometry clamp. Kept dependency-free
// (no localStorage import) so it runs under node --test without a DOM — the
// chatIdentity/homeserverTrust precedent: the load/save halves that touch
// localStorage live in panelGeometryStore.ts instead.
//
// Run: node --test app/lib/panelGeometry.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { clampGeom, displayBox, parseGeom } from "./panelGeometry.ts";

test("clamps into viewport", () => {
  const g = clampGeom({ x: -50, y: 2000, w: 320, h: 480 }, 1280, 800, { w: 260, h: 200 }, { w: 720, h: 760 });
  assert.ok(g.x >= 0 && g.y + g.h <= 800);
});

test("clamps size to min/max", () => {
  const g = clampGeom({ x: 0, y: 0, w: 100, h: 5000 }, 1280, 800, { w: 260, h: 200 }, { w: 720, h: 760 });
  assert.equal(g.w, 260); assert.equal(g.h, 760);
});

test("does not push x/y negative when the clamped box still fits", () => {
  const g = clampGeom({ x: 100, y: 100, w: 300, h: 300 }, 1280, 800, { w: 260, h: 200 }, { w: 720, h: 760 });
  assert.equal(g.x, 100);
  assert.equal(g.y, 100);
  assert.equal(g.w, 300);
  assert.equal(g.h, 300);
});

test("max is also clamped to the viewport when the viewport is smaller than max", () => {
  // A 720-wide max on a 500-wide viewport must never leave the box wider than
  // the viewport itself (mobile/narrow window case).
  const g = clampGeom({ x: 0, y: 0, w: 700, h: 700 }, 500, 400, { w: 260, h: 200 }, { w: 720, h: 760 });
  assert.ok(g.w <= 500);
  assert.ok(g.h <= 400);
});

// ── effectiveH: the content-fit position bound ───────────────────────────────

test("effectiveH lets a content-fit panel reach the viewport bottom", () => {
  // The measured prod bug: nominal h 560, rendered 493, vh 1703 — the panel
  // stopped at y=1143 leaving 68px unreachable. With the rendered height as the
  // bound it can sit flush against the bottom.
  const withoutMeasure = clampGeom({ x: 0, y: 9999, w: 384, h: 560 }, 1058, 1703, { w: 260, h: 200 }, { w: 720, h: 1396 });
  assert.equal(withoutMeasure.y, 1703 - 560, "baseline: bound against the nominal height");

  const withMeasure = clampGeom({ x: 0, y: 9999, w: 384, h: 560 }, 1058, 1703, { w: 260, h: 200 }, { w: 720, h: 1396 }, 493);
  assert.equal(withMeasure.y, 1703 - 493, "should bound against the RENDERED height");
  assert.equal(withMeasure.y + 493, 1703, "panel bottom should reach the viewport bottom");
});

test("effectiveH never changes the height that gets persisted", () => {
  // If the measured height leaked into `h`, a content-fit panel would silently
  // save a height the user never chose and stop following its content.
  const g = clampGeom({ x: 10, y: 10, w: 384, h: 560 }, 1058, 1703, { w: 260, h: 200 }, { w: 720, h: 1396 }, 493);
  assert.equal(g.h, 560);
});

test("effectiveH is ignored when absent or nonsensical", () => {
  const base = clampGeom({ x: 0, y: 9999, w: 384, h: 560 }, 1058, 900, { w: 260, h: 200 }, { w: 720, h: 738 });
  for (const bad of [undefined, 0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    const g = clampGeom({ x: 0, y: 9999, w: 384, h: 560 }, 1058, 900, { w: 260, h: 200 }, { w: 720, h: 738 }, bad);
    assert.equal(g.y, base.y, `bad effectiveH ${String(bad)} should fall back to the nominal bound`);
  }
});

test("effectiveH taller than the viewport still pins the panel to the top", () => {
  const g = clampGeom({ x: 0, y: 500, w: 384, h: 560 }, 1058, 700, { w: 260, h: 200 }, { w: 720, h: 574 }, 5000);
  assert.equal(g.y, 0);
});

// (There is no separate sheet variant — one card shape on every viewport.
// See Window's header.)

// ── parseGeom (persisted geometry + the content-fit flag) ────────────────────

test("parseGeom round-trips a plain geometry", () => {
  assert.deepEqual(parseGeom(JSON.stringify({ x: 10, y: 20, w: 300, h: 400 })),
    { x: 10, y: 20, w: 300, h: 400 });
});

test("parseGeom preserves the content-fit flag both ways", () => {
  // The flag is the persistence contract for content-fit panels: fit:true means
  // "never height-resized, keep following the content"; fit:false means the
  // user chose a height. Dropping it on load would forget the user's choice.
  assert.equal(parseGeom(JSON.stringify({ x: 0, y: 0, w: 300, h: 400, fit: true }))?.fit, true);
  assert.equal(parseGeom(JSON.stringify({ x: 0, y: 0, w: 300, h: 400, fit: false }))?.fit, false);
});

test("parseGeom treats a pre-content-fit row as explicit (no fit field)", () => {
  // Rows saved before the flag existed carry a height the user was already
  // living with — parseGeom must not invent fit for them.
  const g = parseGeom(JSON.stringify({ x: 0, y: 0, w: 300, h: 400 }));
  assert.ok(g && !("fit" in g));
});

test("parseGeom drops a non-boolean fit instead of poisoning the row", () => {
  const g = parseGeom(JSON.stringify({ x: 0, y: 0, w: 300, h: 400, fit: "yes" }));
  assert.deepEqual(g, { x: 0, y: 0, w: 300, h: 400 });
});

test("parseGeom rejects absent/corrupt/partial values", () => {
  assert.equal(parseGeom(null), null);
  assert.equal(parseGeom("not json"), null);
  assert.equal(parseGeom("null"), null);
  assert.equal(parseGeom(JSON.stringify({ x: 0, y: 0, w: 300 })), null, "missing h");
  assert.equal(parseGeom(JSON.stringify({ x: 0, y: 0, w: 300, h: "400" })), null, "stringly h");
  assert.equal(parseGeom(JSON.stringify({ x: NaN, y: 0, w: 300, h: 400 })), null, "NaN serializes to null");
});

// ── Restore is clamped, and the clamp is actually wired up ───────────────────
//
// A restored position must not leave the pop-up outside the visible space when
// the view has changed since it was saved.
//
// A correct clamp that Window no longer calls passes every maths test above.
// So these tests deliberately assert the CALL SITE as well as the maths — a
// unit test of an orphaned function is a green light for a feature nobody is
// running.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const shellSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../components/chrome/Window.tsx"),
  "utf8",
);

test("Window clamps SAVED geometry rather than replaying it", () => {
  // The literal failure: a card parked on a 2560px monitor, reopened at 1280.
  const g = clampGeom({ x: 1800, y: 40, w: 384, h: 560 }, 1280, 800, { w: 260, h: 200 }, { w: 1280, h: 800 });
  assert.ok(g.x + g.w <= 1280, `x=${g.x} w=${g.w} still runs past the right edge`);
  assert.ok(g.x >= 0, "and it must not be shoved to a negative coordinate instead");

  // A desktop width restored on a phone: narrower than the card.
  const phone = clampGeom({ x: 20, y: 20, w: 384, h: 560 }, 390, 780, { w: 260, h: 200 }, { w: 390, h: 780 });
  assert.ok(phone.w <= 390, "the card must shrink to the screen it lands on");
  assert.ok(phone.w >= 260, "but never below the minimum usable width");
  assert.ok(phone.h <= 780, "same vertically");

  // The wiring, which is the half that can silently break. Pinned on the call
  // shape, not on the identifier appearing somewhere in the file — an import
  // left behind after the call site was deleted would satisfy that.
  assert.match(shellSrc, /if \(saved\) \{[\s\S]{0,400}?clampGeom\(/,
    "Window must clamp inside the saved-geometry branch of its initial box");
  assert.doesNotMatch(shellSrc, /if \(saved\) return \{ x: saved\.x/,
    "the verbatim replay must not come back");
});

test("a box already inside the viewport is returned untouched", () => {
  // Otherwise every panel would jump slightly on open, which is worse than the
  // bug being fixed.
  const g = clampGeom({ x: 100, y: 80, w: 384, h: 560 }, 1280, 800, { w: 260, h: 200 }, { w: 1280, h: 800 });
  assert.deepEqual(g, { x: 100, y: 80, w: 384, h: 560 });
});

// ── displayBox: floors are a render-time fit, never a write ──────────────────

test("displayBox: floor grows width in place; x moves only when the viewport forces it", () => {
  const box = { x: 100, y: 50, w: 384, h: 560 };
  // Room to grow rightward: x stays.
  assert.deepEqual(displayBox(box, 632, 1280), { x: 100, y: 50, w: 632, h: 560 });
  // No floor, or floor already met: the SAME object back (render identity).
  assert.equal(displayBox(box, undefined, 1280), box);
  assert.equal(displayBox(box, 300, 1280), box);
  // Growth would overflow: x shifts left just enough (right edge at vw-8).
  assert.deepEqual(displayBox({ ...box, x: 900 }, 632, 1280), { x: 640, y: 50, w: 632, h: 560 });
  // Viewport narrower than the floor: width caps at vw-16, x at 8.
  assert.deepEqual(displayBox(box, 632, 390), { x: 8, y: 50, w: 374, h: 560 });
});
