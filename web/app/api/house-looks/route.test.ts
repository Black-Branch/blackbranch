// /api/house-looks. Source scan — route tests in this
// repo import pool through the @/lib/db alias, which node --test cannot resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
const fn = (name: string) => {
  const at = src.indexOf(`export async function ${name}(`);
  assert.ok(at !== -1, `${name} handler missing`);
  const next = src.indexOf("export async function", at + 10);
  return src.slice(at, next === -1 ? undefined : next);
};

test("GET is public and every blob is stripped of personal keys on the way OUT", () => {
  const get = fn("GET");
  assert.doesNotMatch(get, /requireUser|requireAdmin|auth\(\)/, "signed-out viewers get house looks too");
  assert.match(get, /houseBlob\(migrateSettingsBlob\(/, "the read path does not strip — a seeded house look carries a name colour");
  assert.match(get, /FROM site\.house_looks/);
});

test("a failed read degrades to an empty list, never a 500 the preset row shows", () => {
  assert.match(fn("GET"), /\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/);
});

test("PUT and DELETE refuse anyone but an admin BEFORE touching the table", () => {
  for (const name of ["PUT", "DELETE"]) {
    const body = fn(name);
    const gate = body.indexOf("requireAdmin()");
    assert.ok(gate !== -1, `${name} has no admin gate`);
    assert.match(body, /if \(!admin\) return new Response\("Forbidden", \{ status: 403 \}\)/);
    const write = body.search(/pool\.query/);
    assert.ok(write > gate, `${name} writes before checking the admin`);
  }
});

test("PUT whitelists, strips and caps the blob, and records who published it", () => {
  const put = fn("PUT");
  assert.match(put, /houseBlob\(sanitizeSettingsBlob\(/);
  assert.match(put, /MAX_BLOB_LEN/);
  assert.match(put, /updated_by/);
  assert.match(put, /slot < 1 \|\| slot > 4/);
});

test("END anchor", () => {
  assert.match(src, /export async function DELETE\([\s\S]*\}\s*$/);
});
