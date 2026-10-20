// Hidden-people lists saved before chat lines carried public ids hold canonical ids. The stored
// ones are rewritten ONCE, server-side, into the public ids of that canonical's platforms; a PUT
// never accepts a canonical id (or anything beyond id/name/matrixId), so a viewer cannot write a
// stranger's canonical into their own list and read that person's platforms back (security review
// on this slice). Source scan: the route's aliased imports keep it out of node --test.
// Run: node --test app/lib/behaviorLegacyIds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { sanitizeLists } from "./behaviorLists.ts";

const src = stripComments(readFileSync(join(process.cwd(), "app", "api", "me", "behavior", "route.ts"), "utf8"));

test("PUT drops every canonical-shaped id before it is saved", () => {
  const put = src.slice(src.indexOf("export async function PUT("));
  assert.match(put, /raw\.hidden\.filter\(\(h\) => !\(h && typeof h === "object" && typeof \(h as \{ id\?: unknown \}\)\.id === "string" && isLegacyCanonicalId\(\(h as \{ id: string \}\)\.id\)\)\)/);
  assert.ok(put.indexOf("isLegacyCanonicalId") < put.indexOf("INSERT INTO site.user_behavior"), "filtered after the write");
});

test("a client-sent `also` (or any extra field) never survives sanitizing", () => {
  const l = sanitizeLists({ hidden: [{ id: "pA", name: "A", also: ["pB"], canonicalId: "0a1b2c3d4e5f" }] });
  assert.deepEqual(l.hidden, [{ id: "pA", name: "A", matrixId: null }]);
});

test("GET rewrites the STORED legacy entries once and saves the result; nothing else translates", () => {
  const get = src.slice(src.indexOf("export async function GET()"), src.indexOf("export async function PUT("));
  assert.match(get, /const stored = sanitizeLists\(rows\[0\] \?\? \{\}\);\s*const lists = await rewriteLegacy\(matrixId, stored\)\.catch\(\(\) => stored\);/);
  const rw = src.slice(src.indexOf("async function rewriteLegacy("), src.indexOf("export async function GET()"));
  assert.match(rw, /UPDATE site\.user_behavior SET hidden = \$2::jsonb, updated_at = now\(\) WHERE matrix_id = \$1/,
    "the rewrite must be saved, so it happens once");
  assert.match(rw, /if \(legacy\.length === 0\) return lists;/);
  assert.doesNotMatch(src, /\balso\b/, "no translated-ids field is handed to the client");
  assert.match(src, /return Response\.json\(\{ lists \}\);\s*\}\s*$/, "END anchor");
});
