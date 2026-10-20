import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStep, createSignupProgress, SIGNUP_KEYS } from "./signupProgress.ts";

test("only the six step values parse", () => {
  assert.deepEqual([2, 3, 4, 5, 6, "done"].map(parseStep), [2, 3, 4, 5, 6, "done"]);
  assert.deepEqual(["2", 1, 7, "later", null, undefined].map(parseStep), [2, null, null, null, null, null]);
  assert.deepEqual(SIGNUP_KEYS, ["step"]);
});

function fakePool(rows: { value: string }[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  return { seen, pool: { query: async (sql: string, params: unknown[] = []) => { seen.push({ sql, params }); return { rows, rowCount: rows.length }; } } };
}

test("read returns null with no row, and the parsed step with one", async () => {
  assert.equal(await createSignupProgress({ pool: fakePool([]).pool }).read("@k:site.test"), null);
  const { pool, seen } = fakePool([{ value: "done" }]);
  assert.equal(await createSignupProgress({ pool }).read("@k:site.test"), "done");
  assert.match(seen[0]!.sql, /FROM site\.signup_answers WHERE matrix_id = \$1 AND key = 'step'/);
});

test("write upserts the step as text", async () => {
  const { pool, seen } = fakePool([]);
  await createSignupProgress({ pool }).write("@k:site.test", 3);
  assert.match(seen[0]!.sql, /INSERT INTO site\.signup_answers \(matrix_id, key, value\)/);
  assert.match(seen[0]!.sql, /ON CONFLICT \(matrix_id, key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = now\(\)/);
  assert.deepEqual(seen[0]!.params, ["@k:site.test", "step", "3"]);
});
