// Tests for the stream.place liveness policy.
//
// Same failure mode as the WHEP `disconnected` bug, one rung up the cascade:
// treating a LOCAL, transient condition as a REMOTE, terminal one. Reported from
// live use as the cascade being "too aggressive and kicking people off a working
// beta player". Switching a viewer to YouTube is terminal — there is no path back
// in a session — so a false positive is strictly worse than a slow true positive.
//
// Run: node --test app/lib/livenessPolicy.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProbe, applyVerdict } from "./livenessPolicy.ts";

const ONLINE = { online: true, hidden: false };

test("a 2xx response means up", () => {
  assert.equal(classifyProbe({ kind: "http", ok: true }, ONLINE), "up");
});

test("a non-2xx RESPONSE is trusted even while hidden — the server told us", () => {
  // We reached stream.place and it said no. That is attributable, unlike silence.
  assert.equal(classifyProbe({ kind: "http", ok: false }, ONLINE), "down");
  assert.equal(classifyProbe({ kind: "http", ok: false }, { online: true, hidden: true }), "down");
});

test("THE REGRESSION: a network error while OFFLINE must not blame the remote", () => {
  assert.equal(
    classifyProbe({ kind: "error" }, { online: false, hidden: false }),
    "ignore",
    "the viewer's own connection dropped — stream.place may be perfectly fine"
  );
});

test("a network error in a HIDDEN tab must not blame the remote either", () => {
  // Background tabs throttle timers, so the fetch times out on a healthy stream.
  assert.equal(classifyProbe({ kind: "error" }, { online: true, hidden: true }), "ignore");
});

test("a network error while online AND visible does count", () => {
  // Nothing local to blame — this is the case the probe exists for.
  assert.equal(classifyProbe({ kind: "error" }, ONLINE), "down");
});

test("`ignore` leaves the failure count untouched — it neither counts nor resets", () => {
  // Resetting would be wrong too: a real outage spanning a tab-hide would restart
  // the count each time and might never reach the threshold.
  assert.deepEqual(applyVerdict("ignore", 2, 3), { fails: 2, declareDown: false });
  assert.deepEqual(applyVerdict("ignore", 0, 3), { fails: 0, declareDown: false });
});

test("`up` resets the count", () => {
  assert.deepEqual(applyVerdict("up", 2, 3), { fails: 0, declareDown: false });
});

test("threshold: declares down only on the Nth CONSECUTIVE failure", () => {
  let fails = 0;
  for (const expected of [false, false, true]) {
    const r = applyVerdict("down", fails, 3);
    fails = r.fails;
    assert.equal(r.declareDown, expected);
  }
});

test("a single good probe mid-run resets, so a flapping link never trips it", () => {
  // down, down, UP, down, down -> must NOT declare down at 3 total failures.
  let fails = 0;
  for (const v of ["down", "down", "up", "down", "down"] as const) {
    const r = applyVerdict(v, fails, 3);
    fails = r.fails;
    assert.equal(r.declareDown, false, "a recovery in between must not accumulate");
  }
  assert.equal(fails, 2);
});

test("the exact live scenario: mobile blip on a healthy stream never switches", () => {
  // Viewer goes offline for three poll cycles, then comes back. stream.place was
  // up the whole time. Before the fix this switched them to YouTube permanently.
  let fails = 0;
  let declared = false;
  for (const ctx of [{ online: false, hidden: false }, { online: false, hidden: false }, { online: false, hidden: false }]) {
    const r = applyVerdict(classifyProbe({ kind: "error" }, ctx), fails, 3);
    fails = r.fails;
    declared ||= r.declareDown;
  }
  assert.equal(declared, false, "an offline viewer must not be switched off a working source");
  const back = applyVerdict(classifyProbe({ kind: "http", ok: true }, ONLINE), fails, 3);
  assert.equal(back.fails, 0, "and recovery clears the slate");
});

test("a genuine outage still trips, just a beat later", () => {
  // The safety property: discarding ambiguous failures must not make a real
  // outage undetectable — it keeps failing while we are online and visible.
  let fails = 0;
  let declared = false;
  for (let i = 0; i < 4; i++) {
    const r = applyVerdict(classifyProbe({ kind: "error" }, ONLINE), fails, 3);
    fails = r.fails;
    declared ||= r.declareDown;
  }
  assert.equal(declared, true);
});
