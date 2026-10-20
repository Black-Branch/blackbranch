import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("thread route: reader thread → per-request joins on the root; a missing root is a 404", () => {
  assert.match(src, /forumReader\.thread\(/);
  assert.match(src, /applyJoins\(/);
  assert.match(src, /status: 404/);
});
test("a reader failure is a 503 that no cache remembers; the token never reaches the client", () => {
  assert.match(src, /status: 503/);
  assert.match(src, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(src, /MATRIX_READER_TOKEN/);
  assert.match(src, /\}\s*$/); // END anchor
});
