// The voice on stream-api reads what THIS table promised the donor. The two
// copies cannot import each other (different packages, different runtimes),
// so this test holds them together: any boundary that disagrees fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { donationTtsChars } from "./donationTts.ts";

const require = createRequire(import.meta.url);
const api = require("../../../stream-api/tts-tiers.js") as {
  donationTtsChars: (usd: number) => number;
  DONATION_TTS_TIERS: ReadonlyArray<{ minUsd: number; chars: number }>;
};

test("web and stream-api agree on every tier boundary and one cent either side", () => {
  const probes = [0, 0.01];
  for (const t of api.DONATION_TTS_TIERS) probes.push(t.minUsd - 0.01, t.minUsd, t.minUsd + 0.01);
  probes.push(1000, NaN, -5);
  for (const usd of probes) assert.equal(donationTtsChars(usd), api.donationTtsChars(usd), `$${usd}`);
});
