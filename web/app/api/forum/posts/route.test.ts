import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("posts route: reader → joins → sorted views; room=all means every forum room", () => {
  assert.match(src, /forumReader\.rooms\(\)/);
  assert.match(src, /forumReader\.posts\(/);
  assert.match(src, /loadForumJoins\(pool, /);
  assert.match(src, /sortPostViews\(/);
  assert.match(src, /room === "all"/);
});
test("a reader failure is a 503 that no cache remembers; the token never reaches the client", () => {
  assert.match(src, /status: 503/);
  assert.match(src, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(src, /MATRIX_READER_TOKEN/);
  assert.match(src, /\}\s*$/); // END anchor
});
