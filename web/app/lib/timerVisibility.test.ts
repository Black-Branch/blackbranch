// The marathon timer is PARKED, and the `live` gate that would hide it stays
// inside the component.
//
// A top bar reading
//
//     {live ? <button>LIVE</button> : <StreamTimerIndicator … />}
//
// hides a marathon timer for exactly the window it exists to serve — and
// because the low-timer page glow is portalled from INSIDE
// StreamTimerIndicator, the warning effects never fire while live either. One
// `live ?` costs two features their whole purpose, and nothing fails: no
// error, no test, no type problem.
//
// The on-site timer display is switched off — the OBS overlays carry the
// timer — so the bar does not mount it at all, nor a LIVE pill or OFFLINE
// word. The component is KEPT and `@parked`, so what this file pins is (a)
// that the bar mounts nothing of it, (b) that the component and its default
// export survive the parking, and (c) the shape that prevents the bug above:
// the `live` gate is a PROP consumed inside the component, so whoever un-parks
// it cannot express the visibility rule as a mount condition without deleting
// a pinned line.
//
// Run: node --test app/lib/timerVisibility.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = readFileSync(join(webRoot, "app/components/StreamEmbedBar.tsx"), "utf8");
// Comments are not source — this file's own explanation of the bug mentions the
// very pattern being banned, and the bar's header names the widgets it dropped.
// (Same trap wsFrames/composerLayout/userMenuWiring all document.)
const src = stripComments(raw);
const timer = readFileSync(join(webRoot, "app/components/StreamTimerIndicator.tsx"), "utf8");

test("the player bar mounts no timer and says no OFFLINE", () => {
  // The whole file is in hand, so these negatives are not vacuous over a
  // truncated read: the END anchor proves the scan reached the last line.
  assert.match(src, /\/>\s*\);\s*\}\s*$/, "vacuity anchor — the scan reached the end of the bar");
  assert.doesNotMatch(src, /StreamTimerIndicator/, "the timer is parked, not mounted here");
  assert.doesNotMatch(src, /OFFLINE/, "the OFFLINE word went with the LIVE pill");
});

test("StreamTimerIndicator is kept and parked, with the reason in its own docblock", () => {
  assert.match(timer, /@parked — the on-site timer display is switched off/, "a parked export needs its reason where check-orphans reads it");
  assert.match(
    timer,
    /export default function StreamTimerIndicator/,
    "parked means unmounted, NOT deleted — the component and its glow come back together"
  );
});

test("the timer's live gate is a PROP inside the component, not a mount condition", () => {
  // This is the shape the `live ?` bug violates, and it is the one thing that
  // must survive the parking: whoever re-mounts the timer inherits a
  // component that takes `live` and renders its own fallback, so expressing
  // "hide it when offline" does not require a ternary around the element.
  assert.match(timer, /live: boolean;/, "the gate is a declared prop");
  assert.match(timer, /if \(!live \|\| !timer\.known/, "and it is consumed inside the component");
  assert.match(timer, /return <>\{fallback\}<\/>;/, "the gated branch renders the caller's fallback, not nothing");
});
