// The link-account reminder's timing policy.
//
// Pinned rule by rule: shows at zero linked accounts; a dismissal
// buys 48 h of quiet; the SECOND showing may offer "never again"; never is
// forever. The row-shaped inputs mirror site.user_nudges exactly.
//
// Run: node --test app/lib/nudges.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { linkNudgeState, NUDGE_RETURN_MS } from "./nudges.ts";

const NOW = 1_800_000_000_000;
const row = (agoMs: number, count: number, never = false) => ({
  dismissed_at: new Date(NOW - agoMs),
  count,
  never,
});

test("a fresh user with no links sees it — without the never-again offer", () => {
  // The FIRST showing must not offer never-again (only the second does):
  // "don't ask again" before the reminder has ever repeated is an escape
  // hatch from a nag that hasn't happened.
  assert.deepEqual(linkNudgeState(false, undefined, NOW), { show: true, offerNever: false });
});

test("linking any account retires it, regardless of dismissal state", () => {
  assert.equal(linkNudgeState(true, undefined, NOW).show, false);
  assert.equal(linkNudgeState(true, row(NUDGE_RETURN_MS * 10, 3), NOW).show, false);
});

test("a dismissal buys exactly 48 hours of quiet", () => {
  assert.equal(linkNudgeState(false, row(NUDGE_RETURN_MS - 1, 1), NOW).show, false,
    "still inside the window — showing again is a re-nag");
  assert.equal(linkNudgeState(false, row(NUDGE_RETURN_MS + 1, 1), NOW).show, true,
    "past the window — the reminder must return");
});

test("the second showing offers never-again", () => {
  const second = linkNudgeState(false, row(NUDGE_RETURN_MS + 1, 1), NOW);
  assert.deepEqual(second, { show: true, offerNever: true });
});

test("never is forever — no window ever reopens it", () => {
  assert.equal(linkNudgeState(false, row(NUDGE_RETURN_MS * 1000, 2, true), NOW).show, false);
});

// ── The route's SQL upholds the latch ────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

test("the upsert latches `never` — a later plain dismiss cannot re-arm the nag", () => {
  // The policy above trusts row.never; this pins the WRITE side. A plain
  // dismiss upserting never=false over a stored true would quietly turn
  // "don't ask again" back into "ask again in 48 h".
  const route = stripComments(readFileSync(join(HERE, "../api/nudges/route.ts"), "utf8"));
  assert.match(route, /never = site\.user_nudges\.never OR EXCLUDED\.never/,
    "the never latch is gone from the upsert");
  assert.match(route, /count = site\.user_nudges\.count \+ 1/,
    "count no longer grows per dismissal — offerNever would never turn on");
  // And the decision must come from the ONE policy function, not a re-derive.
  assert.match(route, /linkNudgeState\(linked, nudgeRows\[0\], Date\.now\(\)\)/,
    "the route reimplements the timing policy instead of using linkNudgeState");
});
