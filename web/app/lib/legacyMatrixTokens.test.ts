// A2-08 (P15): the June-era Matrix token columns on site.users are emptied by migration v169, and
// nothing in the product reads them any more. The migration FILE is executed against a real schema
// (SQL_PARSE_DATABASE_URL — a replayed throwaway database; CI sets it; never prod), with a row
// planted the way June left them. Re-running the file is safe (it is idempotent by construction).
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/legacyMatrixTokens.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";

const repo = join(import.meta.dirname, "../../..");
const MIGRATION = join(repo, "migrations", "migrate-v169.sql");
const url = process.env.SQL_PARSE_DATABASE_URL || "";

test("v169 empties the four legacy token columns and touches nothing else on the row", async (t) => {
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const who = "@a208test-june:site.test";
  try {
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    await db.query(
      `INSERT INTO site.users (matrix_id, display_name, mx_access_token, mx_refresh_token, mx_token_expires, mx_device_id)
       VALUES ($1, 'june', 'v1:a:b:c', 'v1:d:e:f', 1781222400000, 'JUNEDEVICE')`, [who]);
    await db.query(readFileSync(MIGRATION, "utf8"));
    const { rows } = await db.query(
      `SELECT mx_access_token, mx_refresh_token, mx_token_expires, mx_device_id, display_name FROM site.users WHERE matrix_id = $1`, [who]);
    assert.deepEqual(rows[0], { mx_access_token: null, mx_refresh_token: null, mx_token_expires: null, mx_device_id: null, display_name: "june" });
    const v = await db.query(`SELECT 1 FROM public.schema_migrations WHERE version = 169`);
    assert.equal(v.rowCount, 1, "the migration records itself");
  } finally {
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    await db.end();
  }
});

test("no product code reads the legacy site.users token columns (the Doctor's token probe reads live sessions only)", () => {
  const doctor = stripComments(readFileSync(join(import.meta.dirname, "doctor", "doctorFacts.ts"), "utf8"));
  assert.doesNotMatch(doctor, /FROM site\.users WHERE mx_refresh_token/);
  assert.match(doctor, /SELECT mx_refresh_token AS t FROM site\.user_sessions WHERE mx_refresh_token LIKE 'v1:%' LIMIT 1/, "vacuity: the probe is still there");
  const readme = readFileSync(join(repo, "migrations", "README.md"), "utf8");
  assert.match(readme, /site\.users\.mx_access_token.*mx_refresh_token.*mx_token_expires.*mx_device_id[\s\S]*?drop/i, "the drop is written down");
});
