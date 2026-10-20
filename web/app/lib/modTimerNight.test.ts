// Fund the Night has to be REACHABLE. stream-api's `/timer/night` is
// requireInternal, and the tunnel egress is deliberately not IP-trusted, so a
// browser cannot call it directly — without the mod panel's control and the
// proxy's action, nobody could open, extend or end a night.
//
// This pins the proxy half: the `night` action exists, forwards the shape
// stream-api's route reads, and — the part that is easy to get wrong — passes
// a 400 THROUGH instead of flattening it into the generic 502. Those 400s are
// the only way the broadcaster learns that "4" is ambiguous or that a night
// has no priced blocks to extend from; a 502 with a swallowed body says
// "something broke".
//
// Source scan (the route imports the auth stack, unreachable by node --test),
// with a vacuity anchor on the END of the file.
//
// Run: node --test app/lib/modTimerNight.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = "app/api/mod/timer/route.ts";
const src = () => readFileSync(join(process.cwd(), ROUTE), "utf8");

// The last construct in the file. Every assertion below is positive (a short
// read looks like deletion and goes red on its own), but the anchor is what
// proves the scan reached the end rather than a truncated prefix.
function assertWholeFileRead(text: string) {
  assert.match(text, /function bad\(msg: string\)[\s\S]*status: 400/,
    "vacuity anchor: the END of route.ts is gone — this scan may have read a truncated file");
}

test("the night action forwards to stream-api's /timer/night", () => {
  const text = src();
  assertWholeFileRead(text);
  assert.match(text, /case "night"/, "there is no `night` action — /timer/night still has no caller");
  const nightCase = /case "night":[\s\S]{0,2200}?break;/.exec(text)?.[0] ?? "";
  assert.match(nightCase, /path = "\/timer\/night"/, "the night action does not target /timer/night");
});

test("the forwarded payload carries action + end + hours (target/seed have their own pin below)", () => {
  const text = src();
  assertWholeFileRead(text);
  const nightCase = /case "night":[\s\S]{0,2200}?break;/.exec(text)?.[0] ?? "";
  assert.match(nightCase, /payload = \{[\s\S]{0,200}?action:/, "the inner action is not forwarded");
  assert.match(nightCase, /\bend\b/, "`end` (the night's end time) is not forwarded — start would always 400");
  assert.match(nightCase, /\bhours\b/, "`hours` is not forwarded — extend would always 400");
});

test("the inner action is validated web-side: only start|extend|end|target may be forwarded", () => {
  const text = src();
  assertWholeFileRead(text);
  assert.match(text, /NIGHT_ACTIONS = new Set\(\["start", "extend", "end", "target"\]\)/,
    "the four legal night actions are not enumerated in the proxy");
  const nightCase = /case "night":[\s\S]{0,2200}?break;/.exec(text)?.[0] ?? "";
  assert.match(nightCase, /return bad\(/, "an unknown night action is not refused with a 400");
});

test("target income and seed ride in translated units: dollars→cents, hours→seconds", () => {
  // The browser speaks dollars and hours; stream-api's route reads
  // `priceCents`/`seedSec`. The translation lives HERE, once — a raw
  // `targetUsd` forwarded untranslated would price a $362 night at $3.62.
  const text = src();
  assertWholeFileRead(text);
  const nightCase = /case "night":[\s\S]{0,2200}?break;/.exec(text)?.[0] ?? "";
  assert.match(nightCase, /priceCents = Math\.round\(usd \* 100\)/,
    "targetUsd is not converted to cents");
  assert.match(nightCase, /seedSec = Math\.round\(seedHours \* 3600\)/,
    "seedHours is not converted to seconds");
  assert.match(nightCase, /return bad\("Target income must be/,
    "an empty/absurd target is not refused with a usage line");
  assert.match(nightCase, /return bad\("Seed must be/,
    "a negative seed is not refused with a usage line");
});

test("a 400 from stream-api reaches the caller as a 400, with its own message", () => {
  // stream-api answers 400 for exactly the caller errors k needs to read
  // ("could not parse endLocal", "no priced blocks to extend from", "extend
  // requires hours > 0"). Flattening those into 502 loses the sentence AND
  // tells the panel the server is broken when it is the input that is.
  const text = src();
  assertWholeFileRead(text);
  const passthrough = /res\.status === 400[\s\S]{0,220}?status: 400/;
  assert.match(text, passthrough,
    "a 400 from stream-api is not passed through — the panel can only say 'that didn't go through'");
  const upstreamFail = text.search(/res\.status === 400/);
  const generic502 = text.search(/status: 502/);
  assert.ok(upstreamFail !== -1 && generic502 !== -1, "premise: both branches exist");
  assert.ok(upstreamFail < generic502,
    "the 400 pass-through must sit BEFORE the generic 502, or every caller error is a 502");
});

test("the night action is behind the same mod check as every other timer action", () => {
  const text = src();
  assertWholeFileRead(text);
  // One gate for the whole handler, before the switch — so this is a check
  // that the gate is still first, not that the night case repeats it.
  const gate = text.search(/const mod = await requireMod\(\)/);
  const switchAt = text.search(/switch \(action\)/);
  assert.ok(gate !== -1, "requireMod is gone — the timer proxy is open to anyone");
  assert.ok(gate < switchAt, "requireMod must run before any action is dispatched");
});
