import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";

// Merging two identities is irreversible. Ban and purge already refuse a
// non-admin mod acting on the owner (assertCanModerate); the merge did not, so
// a mod could fold the owner's linked platform identity into another one.
const src = stripComments(readFileSync(new URL("../api/mod/identity/link/route.ts", import.meta.url), "utf8"));

test("an identity merge passes the same privilege ceiling as ban and purge, for BOTH identities, before the merge is sent", () => {
  const post = src.indexOf("export async function POST");
  assert.ok(post > 0);
  const body = src.slice(post);
  const guard = body.indexOf("for (const id of ids)");
  const check = body.indexOf("await assertCanModerate(mod, id)");
  const merge = body.indexOf('streamApiFetch("/identity/merge"');
  assert.ok(guard > 0 && check > guard, "each of the two canonical ids is checked");
  assert.ok(merge > check, "the check runs before the merge is requested");
  assert.match(body.slice(check, merge), /if \(denied\) return denied;/);
  // vacuity anchor: POST is the last handler, and the scan reached its end
  assert.match(src, /\}\s*$/);
  assert.ok(src.lastIndexOf("export async function") === post, "POST is the last handler in the file");
});
