// Tests for the live-edge correction policy.
//
// The policy is pure for the same reason whepEscalation.ts is: the thing that
// breaks silently is a DECISION, and it cannot be exercised against an offline
// stream. Run: node --test app/lib/liveEdge.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  liveEdgeAction, MIN_HIDDEN_MS, MIN_SINCE_LOAD_MS, DRIFT_GROWTH_S,
} from "./liveEdge.ts";

// A viewer who was away long enough, on a player that can seek, with no
// deliberate rewind. Individual tests override one field at a time.
const base = {
  driftAtHide: 20,
  driftOnReturn: 20,
  hiddenMs: 60_000,
  sinceLoadMs: 120_000,
  viewerSeeked: false,
  lever: "seek" as const,
};

test("THE TRAP: absolute drift must not trigger — YouTube's own latency is already in it", () => {
  // 25s behind before and after. On YouTube a normal-latency viewer reads this
  // ALL THE TIME: getDuration() counts from stream start, so the inherent
  // 15-30s encode/CDN delay is inside every reading. An absolute threshold
  // would fire on every ordinary viewer, forever.
  const a = liveEdgeAction({ ...base, driftAtHide: 25, driftOnReturn: 25 });
  assert.equal(a.kind, "none", "unchanged drift is not drift the viewer accumulated");
});

test("drift that GREW across the hidden window is corrected", () => {
  const a = liveEdgeAction({ ...base, driftAtHide: 20, driftOnReturn: 65 });
  assert.equal(a.kind, "seek");
});

test("the lever decides the action — twitch reloads, it cannot seek", () => {
  const a = liveEdgeAction({ ...base, driftAtHide: 5, driftOnReturn: 60, lever: "reload" });
  assert.equal(a.kind, "reload");
});

test("a source with no lever is never asked to do anything", () => {
  const a = liveEdgeAction({ ...base, driftAtHide: 0, driftOnReturn: 600, lever: "none" });
  assert.equal(a.kind, "none");
});

test("STAND-DOWN: a deliberate backward seek disables correction for the session", () => {
  // YouTube live has DVR. Yanking a viewer forward out of a rewatch is the
  // class of automatic intervention the player audit exists to end.
  const a = liveEdgeAction({ ...base, driftAtHide: 10, driftOnReturn: 300, viewerSeeked: true });
  assert.equal(a.kind, "none");
});

test("a momentary tab flick does not count as being away", () => {
  const a = liveEdgeAction({ ...base, hiddenMs: MIN_HIDDEN_MS - 1, driftOnReturn: 90 });
  assert.equal(a.kind, "none");
});

test("nothing is corrected in the first seconds after load", () => {
  const a = liveEdgeAction({ ...base, sinceLoadMs: MIN_SINCE_LOAD_MS - 1, driftOnReturn: 90 });
  assert.equal(a.kind, "none");
});

test("an unmeasurable drift is never guessed at", () => {
  assert.equal(liveEdgeAction({ ...base, driftAtHide: null, driftOnReturn: 90 }).kind, "none");
  assert.equal(liveEdgeAction({ ...base, driftOnReturn: null }).kind, "none");
});

test("growth exactly at the threshold does not trigger — strictly greater", () => {
  const a = liveEdgeAction({ ...base, driftAtHide: 10, driftOnReturn: 10 + DRIFT_GROWTH_S });
  assert.equal(a.kind, "none");
});

test("a player that caught up on its own is left alone", () => {
  const a = liveEdgeAction({ ...base, driftAtHide: 60, driftOnReturn: 5 });
  assert.equal(a.kind, "none");
});
