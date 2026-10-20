// The capability table is the mechanism that stops our code lying about a
// player. Twitch has no live seek; YouTube has no latency figure. Both facts
// live here as data, so a component reads a value instead of remembering a
// caveat. Run: node --test app/lib/playerAdapter.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, type PlayerCapabilities } from "./playerAdapter.ts";

const FIELDS: (keyof PlayerCapabilities)[] = [
  "volume", "liveEdge", "latency", "quality", "blockedEvent", "errorDetail",
];

test("every source declares every capability — a missing one must not read as false", () => {
  for (const [source, caps] of Object.entries(CAPABILITIES)) {
    for (const field of FIELDS) {
      assert.ok(field in caps, `${source} does not declare ${field}`);
      assert.notEqual((caps as Record<string, unknown>)[field], undefined, `${source}.${field} is undefined`);
    }
  }
});

test("Twitch cannot seek live — its lever is a reload", () => {
  // Their seek() is documented VOD-only. Any design assuming symmetric
  // jump-to-live across sources is wrong at the API level.
  assert.equal(CAPABILITIES.twitch.liveEdge, "reload");
});

test("YouTube exposes no latency figure", () => {
  // There is no latency in the IFrame API at all, which is why a cross-source
  // latency comparison is refused.
  assert.equal(CAPABILITIES.youtube.latency, false);
});

test("Twitch does expose a real latency figure", () => {
  assert.equal(CAPABILITIES.twitch.latency, true);
});

test("YouTube's lever is a seek", () => {
  assert.equal(CAPABILITIES.youtube.liveEdge, "seek");
});
