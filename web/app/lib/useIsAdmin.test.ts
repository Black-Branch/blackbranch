// No precedent for testing fetch-driven hook state in this codebase — pins
// the hook's shape by source scan (same approach as usePaymentResult.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const src = stripComments(readFileSync(new URL("./useIsAdmin.ts", import.meta.url), "utf8"));

test("reads /api/me's isAdmin field, once", () => {
  assert.match(src, /getJson<[^>]*>\("\/api\/me"/);
  assert.match(src, /\.isAdmin/);
});
test("returns null while loading — the shape ModPanel/ModWindow gate on", () => {
  assert.match(src, /useState<boolean \| null>\(null\)/);
});
