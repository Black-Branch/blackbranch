// web/app/api/billing/result/route.test.ts
// Source-scan — route.ts imports pool via the @/lib/db alias (through
// paymentResultServer.ts). Behavior is covered by paymentResultServer.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const src = stripComments(raw);

test("route.ts is whole", () => {
  assert.ok(raw.trimEnd().endsWith("}"), "result/route.ts truncated — pins below are vacuous");
});

test("no auth guard — a cs_... id is unguessable", () => {
  assert.ok(!src.includes("requireMod") && !src.includes("requireAdmin"));
});

test("rate-limited on session:<id>, 5 minutes / 200 requests", () => {
  assert.match(src, /createSlidingWindowLimiter\(\s*5\s*\*\s*60_000\s*,\s*200\s*\)/);
  assert.match(src, /`session:\$\{session\}`/);
});

test("also rate-limited per IP, 5 minutes / 1000 requests", () => {
  assert.match(src, /createSlidingWindowLimiter\(\s*5\s*\*\s*60_000\s*,\s*1000\s*\)/);
  assert.match(src, /ipKey\(req\)/);
});

test("both outcomes share one response shape", () => {
  assert.match(src, /outcome:\s*"none"/);
  assert.match(src, /outcome:\s*"failed"/);
});

test("an unparsable since is a 400, not an Invalid Date handed to pg", () => {
  assert.match(src, /Number\.isNaN\(since\.getTime\(\)\)/);
});
