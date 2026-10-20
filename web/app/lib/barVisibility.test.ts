// Which of the player's two bars are on screen, as ONE distance each.
// Run: node --test app/lib/barVisibility.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { barVisibility, type BarInputs } from "./barVisibility.ts";

const BASE: BarInputs = { narrow: false, barsHidden: false, theatre: false };
const at = (o: Partial<BarInputs>) => barVisibility({ ...BASE, ...o });

test("at rest both bars are in flow and nothing is hidden", () => {
  assert.deepEqual(at({}), { overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true });
});

// The full 2×2×2 table — every combination of the three inputs, asserting the
// full quadruple each time. `keyboardOpen` is not one of the three axes: the
// keyboard is not an input to this function and must not
// come back as a fourth column here — see barVisibility.ts's header for where it
// lives (the video column ramp, driven straight off `html.kb-open`).
const TABLE: Array<[BarInputs, ReturnType<typeof barVisibility>]> = [
  [{ narrow: false, barsHidden: false, theatre: false }, { overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true }],
  [{ narrow: false, barsHidden: false, theatre: true }, { overlay: true, topHidden: false, bottomHidden: false, barsInFlow: true }],
  [{ narrow: false, barsHidden: true, theatre: false }, { overlay: true, topHidden: false, bottomHidden: false, barsInFlow: false }],
  [{ narrow: false, barsHidden: true, theatre: true }, { overlay: true, topHidden: false, bottomHidden: false, barsInFlow: false }],
  [{ narrow: true, barsHidden: false, theatre: false }, { overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true }],
  [{ narrow: true, barsHidden: false, theatre: true }, { overlay: false, topHidden: false, bottomHidden: false, barsInFlow: true }],
  [{ narrow: true, barsHidden: true, theatre: false }, { overlay: false, topHidden: true, bottomHidden: true, barsInFlow: false }],
  [{ narrow: true, barsHidden: true, theatre: true }, { overlay: false, topHidden: true, bottomHidden: true, barsInFlow: false }],
];

test("all 8 combinations of {narrow, barsHidden, theatre}", () => {
  for (const [inputs, expected] of TABLE) {
    assert.deepEqual(barVisibility(inputs), expected, JSON.stringify(inputs));
  }
});

// Named regression: on a phone, simply being narrow must never hide the top
// bar on its own — only the explicit compact toggle (`barsHidden`) does. THE
// KEYBOARD MUST NOT APPEAR IN THIS FILE — its bar-visibility effect is
// entirely the video column ramp (globals.css's phone block, driven by
// `html.kb-open`), which this pure function has no way to see and must not.
test("narrow alone (no compact) never hides the top bar", () => {
  const v = at({ narrow: true, barsHidden: false, theatre: false });
  assert.equal(v.topHidden, false);
});

test("mobile compact hides BOTH bars; the chat tab bar's toggle is the way back", () => {
  assert.deepEqual(at({ narrow: true, barsHidden: true }), { overlay: false, topHidden: true, bottomHidden: true, barsInFlow: false });
});

test("desktop compact and theatre are OVERLAYS — phones have no hover to reveal with", () => {
  for (const o of [{ barsHidden: true }, { theatre: true }, { barsHidden: true, theatre: true }]) {
    const v = at(o);
    assert.equal(v.overlay, true);
    assert.equal(v.topHidden, false);
    assert.equal(v.bottomHidden, false);
  }
  assert.equal(at({ narrow: true, theatre: true }).overlay, false, "never an overlay on a phone");
});

test("the truth table has no state where a bar is hidden AND an overlay", () => {
  for (const narrow of [false, true])
  for (const barsHidden of [false, true]) for (const theatre of [false, true]) {
    const v = barVisibility({ narrow, barsHidden, theatre });
    if (v.overlay) assert.equal(v.bottomHidden, false, JSON.stringify({ narrow, barsHidden, theatre }));
    assert.equal(v.barsInFlow, !barsHidden);
  }
});
