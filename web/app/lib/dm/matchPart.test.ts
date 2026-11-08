import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPart } from "./matchPart.ts";

test("matches anywhere in the name, ignoring case, keeping the name's own letters", () => {
  assert.deepEqual(matchPart("JonFreeholder", "free"), { before: "Jon", match: "Free", after: "holder" });
  assert.deepEqual(matchPart("robin", "@RO"), { before: "", match: "ro", after: "bin" });
  assert.equal(matchPart("robin", "sam"), null);
  assert.equal(matchPart("robin", "  "), null, "an empty query marks nothing");
});
