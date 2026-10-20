// The four device questions — one spelling each.
//
// A tablet at 800px with a touch screen is "mobile" to deviceClass() and
// "desktop" to the narrow-viewport query. Both are correct for the question
// they ask. This file exists so that stays deliberate instead of accidental.
//
// Run: node --test app/lib/deviceQueries.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  NARROW_BREAKPOINT, Q_NARROW, Q_DEVICE_MOBILE, Q_POINTER_COARSE, Q_TOUCH_PRIMARY,
} from "./deviceQueries.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

test("the four queries are four DIFFERENT questions", () => {
  const all = [Q_NARROW, Q_DEVICE_MOBILE, Q_POINTER_COARSE, Q_TOUCH_PRIMARY];
  assert.equal(new Set(all).size, 4, `two questions collapsed to one spelling: ${all.join(" | ")}`);
});

test("narrow-viewport and device-mobile DISAGREE on a coarse 800px tablet", () => {
  // This is the whole reason the module exists. If this test ever passes by
  // agreement, someone has merged two questions that answer differently — and
  // the tablet band silently changes behaviour.
  assert.match(Q_NARROW, /max-width:\s*767px/);
  assert.match(Q_DEVICE_MOBILE, /max-width:\s*1024px/);
  assert.match(Q_DEVICE_MOBILE, /pointer:\s*coarse/);
  assert.doesNotMatch(Q_NARROW, /pointer/,
    "narrow-viewport must stay a pure WIDTH question — adding pointer to it makes it a second deviceClass()");
});

test("touch-primary is strictly narrower than pointer-coarse", () => {
  assert.ok(Q_TOUCH_PRIMARY.includes("hover: none"),
    "touch-primary is what distinguishes a phone from a touchscreen laptop");
  assert.doesNotMatch(Q_POINTER_COARSE, /hover/,
    "pointer-coarse asks only whether touch EXISTS");
});

test("the breakpoint constant and the narrow query cannot drift", () => {
  assert.equal(Q_NARROW, `(max-width: ${NARROW_BREAKPOINT - 1}px)`);
});

test("the ambiguous name `isMobile` is gone from app/", () => {
  // "isMobile" cannot say WHICH question it means, which is how a paint-budget
  // check and a layout check end up sharing a prop. Distinct names are the fix;
  // this test is what stops it growing back.
  //
  // The banned string is spelled here only inside the regex literal below —
  // a bulk rename that rewrites this file's prose must not rewrite the thing
  // being banned, or the guard quietly starts checking for the new name.
  const offenders = walk(join(process.cwd(), "app"))
    .filter((f) => /\bisMobile\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(process.cwd() + "/", ""));
  assert.deepEqual(offenders, [], `still ambiguous: ${offenders.join(", ")}`);
});
