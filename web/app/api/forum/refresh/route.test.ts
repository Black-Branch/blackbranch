import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("refresh is signed-in only and rate-limited — a public cache-buster would be a homeserver DoS lever", () => {
  assert.match(src, /await auth\(\)/);
  assert.match(src, /status: 401/);
  assert.match(src, /createSlidingWindowLimiter\(60_000, 6\)/);
  assert.match(src, /status: 429/);
  assert.match(src, /forumReader\.invalidate\(roomId\)/);
  assert.match(src, /status: 204/);
  assert.match(src, /\}\s*$/); // END anchor
});
