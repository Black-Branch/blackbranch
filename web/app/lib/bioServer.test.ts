import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBio, createBioServer, BIO_MAX } from "./bioServer.ts";

test("a bio is one line of at most 200 visible characters", () => {
  assert.equal(BIO_MAX, 200);
  assert.equal(sanitizeBio("hi\nthere​  "), "hi there");
  assert.equal(sanitizeBio("x".repeat(250)).length, 200);
  assert.equal(sanitizeBio(42), "");
  assert.equal(sanitizeBio(null), "");
});

function fakePool() {
  const seen: { sql: string; params: unknown[] }[] = [];
  return { seen, pool: { query: async (sql: string, params: unknown[] = []) => { seen.push({ sql, params }); return { rows: [], rowCount: 1 }; } } };
}

test("setBio writes the sanitised text and returns it", async () => {
  const { pool, seen } = fakePool();
  const stored = await createBioServer({ pool }).setBio("@k:site.test", "  I watch\nfor the takes  ");
  assert.equal(stored, "I watch for the takes");
  assert.match(seen[0]!.sql, /UPDATE site\.users SET bio = \$1 WHERE matrix_id = \$2/);
  assert.deepEqual(seen[0]!.params, ["I watch for the takes", "@k:site.test"]);
});

test("an empty bio stores NULL", async () => {
  const { pool, seen } = fakePool();
  assert.equal(await createBioServer({ pool }).setBio("@k:site.test", "   "), "");
  assert.deepEqual(seen[0]!.params, [null, "@k:site.test"]);
});
