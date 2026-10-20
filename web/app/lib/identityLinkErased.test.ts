// /api/mod/identity/link must never take the erased-person row (stream-api account-erase.js
// ERASED_CANONICAL, '(erased)') as either side of a merge: it holds every deleted person's kept
// lines and payments; merging it into someone would hand them all of that, and merging someone
// into it would erase them. Source scan (aliased imports keep the route out of node --test).
// Run: node --test app/lib/identityLinkErased.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { ERASED_CANONICAL } from "./erasedPerson.ts";

const src = stripComments(readFileSync(join(process.cwd(), "app", "api", "mod", "identity", "link", "route.ts"), "utf8"));
const REFUSE = 'if (ids.includes(ERASED_CANONICAL)) return new Response("a deleted person\'s record cannot be merged", { status: 400 });';

test("the erased row is the same id stream-api uses", () => {
  assert.equal(ERASED_CANONICAL, "(erased)");
  const api = readFileSync(join(process.cwd(), "..", "stream-api", "account-erase.js"), "utf8");
  assert.match(api, /const ERASED_CANONICAL = '\(erased\)';/);
});

test("the merge (POST) refuses the erased row on either side, before the ceiling and the merge call", () => {
  const post = src.slice(src.indexOf("export async function POST("));
  const at = post.indexOf(REFUSE);
  assert.ok(at > 0, "POST does not refuse the erased row");
  assert.ok(at < post.indexOf("assertCanModerate(mod, id)"), "refused only after other work");
  assert.ok(at < post.indexOf('streamApiFetch("/identity/merge"'), "refused after the merge call");
});

test("the preview refuses it and the search never offers it", () => {
  const get = src.slice(src.indexOf("export async function GET("), src.indexOf("export async function POST("));
  assert.ok(get.includes(REFUSE), "the preview does not refuse the erased row");
  assert.match(get, /AND u\.id <> \$2/);
  assert.match(get, /\[`%\$\{q\}%`, ERASED_CANONICAL\]/);
  assert.match(src, /merged: d\.merged \?\? 1 \}\);\s*\}\s*$/, "END anchor");
});
