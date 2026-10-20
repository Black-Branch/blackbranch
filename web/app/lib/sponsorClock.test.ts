// Tests for the Fund the Night chat-badge matcher (pure, node --test, no DOM).
//
// Run: node --test app/lib/sponsorClock.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { clockRemainSecFor, clockFracFor, type Sponsor } from "./sponsorClock.ts";

const POOL: Sponsor[] = [
  { name: "okletsgo", weightPct: 41.2, clockRemainSec: 812, clockTotalSec: 1200 },
  { name: "nightcrew_sam", weightPct: 28.5, clockRemainSec: 0, clockTotalSec: 900 },
  { name: "Viewer2041", weightPct: 12.1, clockRemainSec: 340, clockTotalSec: 340 },
];

test("clockFracFor: remaining over the badge window, clamped to [0, 1]", () => {
  assert.ok(Math.abs(clockFracFor(POOL, "okletsgo") - 812 / 1200) < 1e-9);
  assert.equal(clockFracFor(POOL, "Viewer2041"), 1, "a fresh badge is fully lit");
  assert.equal(clockFracFor(POOL, "nightcrew_sam"), 0, "given but not funding now: nothing to draw");
  assert.equal(clockFracFor(POOL, "some_lurker"), 0);
  assert.equal(clockFracFor(null, "okletsgo"), 0);
});

test("clockFracFor: a lit badge with no/zero window reads FULL, never empty (older frame shape)", () => {
  const legacy = [{ name: "a", weightPct: 100, clockRemainSec: 30, clockTotalSec: 0 }] as Sponsor[];
  assert.equal(clockFracFor(legacy, "a"), 1);
});

test("clockFracFor: duplicate rows (live + replay) sum both numerator and denominator", () => {
  const dup: Sponsor[] = [
    { name: "Dana", weightPct: 50, clockRemainSec: 100, clockTotalSec: 200 },
    { name: "dana", weightPct: 50, clockRemainSec: 50, clockTotalSec: 100 },
  ];
  assert.equal(clockFracFor(dup, "DANA"), 0.5);
});

test("matches by username, case-insensitive", () => {
  assert.equal(clockRemainSecFor(POOL, "okletsgo"), 812);
  assert.equal(clockRemainSecFor(POOL, "OKLETSGO"), 812);
  assert.equal(clockRemainSecFor(POOL, "OkLetsGo"), 812);
  assert.equal(clockRemainSecFor(POOL, "viewer2041"), 340);
});

test("a name in the pool with clockRemainSec 0 renders nothing (given, not currently funding)", () => {
  assert.equal(clockRemainSecFor(POOL, "nightcrew_sam"), 0);
});

test("a name not in the pool at all is 0", () => {
  assert.equal(clockRemainSecFor(POOL, "some_lurker"), 0);
});

test("null/undefined/empty username is 0, never throws", () => {
  assert.equal(clockRemainSecFor(POOL, null), 0);
  assert.equal(clockRemainSecFor(POOL, undefined), 0);
  assert.equal(clockRemainSecFor(POOL, ""), 0);
  assert.equal(clockRemainSecFor(POOL, "   "), 0);
});

test("empty or missing pool is 0, never throws", () => {
  assert.equal(clockRemainSecFor([], "okletsgo"), 0);
  assert.equal(clockRemainSecFor(null, "okletsgo"), 0);
  assert.equal(clockRemainSecFor(undefined, "okletsgo"), 0);
});

// The live-vs-replay identity caveat (sponsors.js header comment): a donor
// can occupy TWO rows with the same display name until the next restart folds
// them together (live keys on username; replay re-keys on user_id). The
// matcher sums every row matching the name rather than picking one, so a
// viewer's badge reflects the whole pool regardless of which key(s) it landed
// under.
test("two pool rows with the same display name sum, not first-match-wins", () => {
  const dup: Sponsor[] = [
    { name: "dupe", weightPct: 10, clockRemainSec: 100, clockTotalSec: 100 },
    { name: "dupe", weightPct: 5, clockRemainSec: 50, clockTotalSec: 50 },
  ];
  assert.equal(clockRemainSecFor(dup, "dupe"), 150);
});

test("a negative or non-finite clockRemainSec on the wire is ignored, not subtracted", () => {
  // Server-side this is always clamped to >= 0 (Math.max(0, ...) in
  // sponsors.js buildFrame()), but the matcher must not trust the wire blindly.
  const bad: Sponsor[] = [
    { name: "glitch", weightPct: 1, clockRemainSec: -50, clockTotalSec: 60 },
    { name: "glitch", weightPct: 1, clockRemainSec: NaN, clockTotalSec: 60 },
  ];
  assert.equal(clockRemainSecFor(bad, "glitch"), 0);
});

test("matches an ALIAS too: a donor credited under their site display name still lights on a platform-side line", () => {
  // Streamlabs "GadgetFan" is @gadgetfan:site.test "Gadget Qorm" (the name
  // chat shows); sponsors.js names the row by the site account and keeps the
  // donation name as an alias.
  const pool: Sponsor[] = [
    { name: "Gadget Qorm", aliases: ["GadgetFan"], weightPct: 100, clockRemainSec: 90, clockTotalSec: 120 },
  ];
  assert.equal(clockRemainSecFor(pool, "Gadget Qorm"), 90, "native line, by name");
  assert.equal(clockRemainSecFor(pool, "gadgetfan"), 90, "Twitch line, by alias, case-insensitive");
  assert.equal(clockRemainSecFor(pool, "Gadget"), 0, "a prefix is not a match");
  assert.equal(clockFracFor(pool, "GADGETFAN"), 0.75);
  const legacy = [{ name: "Gadget Qorm", weightPct: 100, clockRemainSec: 90, clockTotalSec: 120 }] as Sponsor[];
  assert.equal(clockRemainSecFor(legacy, "gadgetfan"), 0, "an older frame with no aliases field matches by name only");
});
