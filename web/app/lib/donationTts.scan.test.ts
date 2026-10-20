import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
const route = read("../api/billing/donate/route.ts");
// The mechanism lives in the shared TipForm — the message cap and its readout
// live once, for every tip surface.
const form = read("../features/support/TipForm.tsx");

test("the donate route's cap is the tier for the amount, and it rejects rather than cuts", () => {
  assert.match(route, /donationTtsChars\(cents \/ 100\)/);
  assert.match(route, /rawMsg\.length > maxMessage/);
  assert.doesNotMatch(route, /MAX_MESSAGE/);
  assert.doesNotMatch(route, /\.slice\(0, maxMessage\)/);
  // Sanitizing at the default (500) cap before this check is the same bug as
  // the flat-500 chat cut — the top donation tier IS 500, so an over-long
  // top-tier message would be silently cut to exactly 500 and could never
  // measure as over `maxMessage`.
  assert.match(route, /sanitizeChatMessage\([^,]+, maxMessage \+ 1\)/);
});

test("the form caps the box at the tier, shows the readout, and holds the button on an over-long draft", () => {
  assert.match(form, /const ttsChars = donationTtsChars\(validAmount \? effective : 0\)/);
  assert.match(form, /maxLength=\{ttsChars\}/);
  assert.match(form, /donationTtsLine\(validAmount \? effective : 0\)/);
  assert.match(form, /<CharCounter length=\{message\.length\} max=\{ttsChars\}/);
  assert.match(form, /\|\| messageTooLong/);
  assert.doesNotMatch(form, /MAX_MESSAGE/);
});

test("vacuity anchors", () => {
  // The literal last TWO non-blank lines of each file, after stripComments +
  // trimEnd — a bare /\}$/ also matches a
  // file truncated one line short of its real end; two consecutive literal
  // lines is a much narrower coincidence. Checked against each file's OWN
  // actual ending: the donate route's POST handler closes on its final
  // `return Response.json(...)` line, and TipForm's component fn closes
  // `  );\n}`.
  assert.match(route.trimEnd(), /  return Response\.json\(\{ clientSecret: checkout\.client_secret, sessionId: checkout\.id \}\);\n\}$/);
  assert.match(form.trimEnd(), /  \);\n\}$/);
});
