// A gift to someone on a PAID sub must start when their paid period ends.
//
// A stacking GREATEST that looked only at earlier gifts would start a gift
// to an active subscriber at now() and run it concurrently with the months
// they had already paid for — part of the gift simply wasted.
//
// Run: node --test app/lib/giftStacking.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { isActiveStatus } from "./tiers.ts";

const src = readFileSync(join(process.cwd(), "app/lib/giftServer.ts"), "utf8");

test("the stacking GREATEST includes the recipient's paid period end", () => {
  assert.match(src.slice(-400), /\}\s*$/, "giftServer.ts did not end as expected — the read is truncated");
  const s = stripComments(src);
  assert.match(s,
    /GREATEST\(\s*now\(\),\s*COALESCE\(\(SELECT MAX\(expires_at\) FROM site\.gift_subscriptions WHERE recipient_matrix_id = \$3\), now\(\)\),\s*COALESCE\(\(SELECT current_period_end FROM site\.subscriptions\s*WHERE matrix_id = \$3 AND status IN \('active', 'trialing', 'past_due'\)\), now\(\)\)\s*\) \+ make_interval\(months => \$4\)/,
    "the gift clock must start at the LATEST of now, the last gift's end and the paid period's end");
});

test("the SQL status list is exactly tiers.isActiveStatus", () => {
  const m = stripComments(src).match(/status IN \(([^)]*)\)/);
  assert.ok(m, "the status list is gone from the stacking query");
  const listed = (m?.[1] ?? "").split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
  for (const st of listed) assert.ok(isActiveStatus(st), `${st} is in the SQL list but tiers.isActiveStatus says it is not entitled`);
  for (const st of ["active", "trialing", "past_due"]) assert.ok(listed.includes(st), `${st} is entitled per tiers.ts but missing from the SQL list`);
  for (const st of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) assert.ok(!isActiveStatus(st), `vacuity: ${st} unexpectedly entitled`);
});
