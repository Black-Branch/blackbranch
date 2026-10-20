import { test } from "node:test";
import assert from "node:assert/strict";
import { donationTtsChars, donationTtsLine } from "./donationTts.ts";

test("tiers at every boundary", () => {
  for (const [usd, chars] of [[0, 50], [4.99, 50], [5, 150], [9.99, 150], [10, 300], [24.99, 300], [25, 500], [1000, 500]] as const) {
    assert.equal(donationTtsChars(usd), chars, `$${usd}`);
  }
  assert.equal(donationTtsChars(NaN), 50);
  assert.equal(donationTtsChars(-1), 50);
});

test("the readout names the number", () => {
  assert.equal(donationTtsLine(10), "Reads up to 300 characters on stream");
});
