// The inline media box: Discord's rule is "fit the source's aspect inside a
// fixed box, never enlarge past the source's own pixels". The numbers here are
// real bridged uploads.
//
// Run: node --test app/lib/mediaFit.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { fitMediaBox, MEDIA_BOX_W } from "./mediaFit.ts";

test("the box is Discord's 550×350", () => {
  assert.equal(MEDIA_BOX_W, 550);
  // MEDIA_BOX_H is not exported (its only non-test reader is the default
  // parameter in the same file, and check-orphans does not count a test as a
  // caller); a square source proves the height cap instead.
  assert.deepEqual(fitMediaBox(1000, 1000), { width: 350, height: 350, aspect: "1000 / 1000" });
});

test("a landscape Discord screenshot (1080×694) is height-bound at 350", () => {
  assert.deepEqual(fitMediaBox(1080, 694), { width: 545, height: 350, aspect: "1080 / 694" });
});

test("a wide video frame (1560×720) is width-bound at 550", () => {
  assert.deepEqual(fitMediaBox(1560, 720), { width: 550, height: 254, aspect: "1560 / 720" });
});

test("a portrait tweet video (1080×1698) is height-bound", () => {
  assert.deepEqual(fitMediaBox(1080, 1698), { width: 223, height: 350, aspect: "1080 / 1698" });
});

test("a small image is never upscaled", () => {
  assert.deepEqual(fitMediaBox(200, 100), { width: 200, height: 100, aspect: "200 / 100" });
  assert.deepEqual(fitMediaBox(550, 350), { width: 550, height: 350, aspect: "550 / 350" });
});

test("event info arrives as strings sometimes — numeric strings work", () => {
  assert.deepEqual(fitMediaBox("1080", "694"), { width: 545, height: 350, aspect: "1080 / 694" });
});

test("a custom box is honoured", () => {
  assert.deepEqual(fitMediaBox(1080, 694, 100, 100), { width: 100, height: 64, aspect: "1080 / 694" });
});

test("degenerate input returns null, never a NaN box", () => {
  for (const [w, h] of [[0, 100], [100, 0], [-1, 100], [NaN, 100], ["x", 100], [undefined, undefined], [null, 5], [Infinity, 5]] as const) {
    assert.equal(fitMediaBox(w, h), null, `${String(w)}×${String(h)}`);
  }
  assert.equal(fitMediaBox(100, 100, 0, 100), null);
  assert.equal(fitMediaBox(100, 100, 100, NaN), null);
});

// Vacuity anchor at the END: the helper scales, it does not echo its input.
test("the helper genuinely scales", () => {
  assert.notDeepEqual(fitMediaBox(1080, 694), { width: 1080, height: 694, aspect: "1080 / 694" });
});
