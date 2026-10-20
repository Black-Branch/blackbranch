// Pins HANDLED_EVENTS against webhook/route.ts's actual case strings — the
// "scan-asserts-a-list-against-source-text" shape (cf. overlayFrames.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { HANDLED_EVENTS } from "./stripeWebhookEvents.ts";

const src = stripComments(readFileSync(new URL("../api/billing/webhook/route.ts", import.meta.url), "utf8"));
const caseStrings = (s: string) => [...s.matchAll(/case "([a-z_.]+)":/g)].map((m) => m[1]!);

test("HANDLED_EVENTS is exactly the set of case strings in webhook/route.ts", () => {
  assert.deepEqual([...new Set(caseStrings(src))].sort(), [...new Set(HANDLED_EVENTS)].sort());
});

test("HANDLED_EVENTS has 13 entries, no duplicates", () => {
  assert.equal(HANDLED_EVENTS.length, 13);
  assert.equal(new Set(HANDLED_EVENTS).size, 13);
});

test("vacuity anchor: the switch's LAST case string is present", () => {
  const found = caseStrings(src);
  const last = found[found.length - 1];
  assert.ok(last, "premise: at least one case was found");
  assert.ok(HANDLED_EVENTS.includes(last as (typeof HANDLED_EVENTS)[number]), `last case "${last}" missing`);
});
