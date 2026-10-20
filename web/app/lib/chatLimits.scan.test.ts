import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
const input = read("../features/chat/ChatInput.tsx");
const field = read("../components/ChatComposerField.tsx");
const route = read("../api/chat/send/route.ts");

test("the composer's limit comes from chatLimits, not a literal", () => {
  assert.match(input, /chatCharLimit\(\{ isMod, isAdmin \}/);
  assert.match(input, /maxLength=\{charLimit\}/);
  assert.match(input, /counterMax=\{charLimit\}/);
  assert.doesNotMatch(input, /maxLength=\{500\}/);
});

test("the field renders the counter only when asked and only while expanded", () => {
  assert.match(field, /counterMax != null && expanded && \(\s*<CharCounter/);
});

test("the send route rejects over-limit with 413 and names the number", () => {
  // isMod: isPrivileged (not a bare is_mod flag):
  // isPrivileged folds in STAFF_MATRIX_IDS, so Casey/Gadget aren't held to
  // the viewer limit just because their row's is_mod/is_admin are unset.
  assert.match(route, /chatCharLimit\(\s*\{ isMod: isPrivileged, isAdmin: /);
  assert.match(route, /message\.length > charLimit/);
  assert.match(route, /Messages are limited to \$\{charLimit\} characters\./);
  assert.match(route, /status: 413/);
});

test("the route sanitizes past charLimit, and any cut is refused, before the length check", () => {
  // sanitizeChatMessage must not cap at its own default (500) before this
  // length check runs — 500 is also the STAFF ceiling, so a mod's over-length
  // message would be silently cut to exactly 500 and never measure as "over"
  // 500. The property: an over-limit message must always MEASURE as over,
  // never be trimmed into passing.
  //
  // The cap is wider than `charLimit + 1` because `||marks||` don't count
  // toward the limit — and a message that reaches the cap is refused outright,
  // since a cut could drop a closing mark and publish the hidden words.
  assert.match(route, /const rawCap = charLimit \* 2 \+ 1;/);
  assert.match(route, /sanitizeChatMessage\([^,]+,\s*rawCap\)/);
  assert.match(route, /if \(rawTruncated \|\| message\.length > charLimit\)/);
});

test("the ban check, the blocklist and the length check run in that order", () => {
  // The 413 length check moved to AFTER both the ban check and the blocklist,
  // so a banned sender still gets 403 and a blocklisted over-long message is
  // still recorded — neither is silently replaced by a plain length error.
  const banIdx = route.indexOf("status: 403");
  const blocklistIdx = route.indexOf("recordBlocklistHit(");
  const charLimitIdx = route.indexOf("message.length > charLimit");
  assert.ok(
    banIdx > 0 && banIdx < blocklistIdx && blocklistIdx < charLimitIdx,
    `expected ban (${banIdx}) < blocklist (${blocklistIdx}) < charLimit (${charLimitIdx})`
  );
});

test("vacuity anchors: each scanned file still ends where it did", () => {
  // The literal last TWO non-blank lines of each file, after stripComments +
  // trimEnd — a bare /\}$/ also matches a
  // file truncated one line short of its real end (nearly everything here
  // ends in `}`); two consecutive literal lines is a much narrower
  // coincidence. Each was checked against its OWN actual ending, not copied
  // on a guess: ChatInput's and ChatComposerField's component fns both close
  // `  );\n}`, the route's POST handler closes on its final `return new
  // Response("OK");` line.
  assert.match(input.trimEnd(), /  \);\n\}$/);
  assert.match(field.trimEnd(), /  \);\n\}$/);
  assert.match(route.trimEnd(), /  return new Response\("OK"\);\n\}$/);
});
