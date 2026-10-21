// Source scan (the route imports pool-backed modules through the @/ alias,
// like every route test in this repo): the route is wiring over boards.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("signed-in guard first, then a validated face + window, then findRank over the caller's identities", () => {
  assert.match(src, /const who = await requireUser\(\);\s*if \(typeof who !== "string"\) return who;/);
  // faceIdOf validates the id — boardFaces.test.ts pins it.
  assert.match(src, /const face = faceIdOf\(req\.nextUrl\.searchParams\.get\("face"\)\);/);
  assert.match(src, /if \(face === null \|\| !isWindowId\(window\)\) return Response\.json\(\{ error: "bad face or window" \}, \{ status: 400 \}\);/);
  assert.match(src, /resolveIdentities\(\{ matrixId: who \}\)/);
  // The caller's own keys are the keys a board row carries: Matrix ids and the public id of each
  // platform identity they hold (boards.ts publicKey) — never a canonical.
  assert.match(src, /const keys = \[\.\.\.ids\.matrixIds, \.\.\.rows\.map\(\(r\) => publicIdFor\(r\.canonical, r\.platform\)\)\.filter\(\(k\): k is string => !!k\)\];/);
  assert.match(src, /findRank\(face, window, keys\)/);
  assert.match(src, /"Cache-Control": "private, no-store"/);
  assert.doesNotMatch(src, /bot\/top|support/);
  assert.equal((src.match(/pool\.query/g) ?? []).length, 1, "one identity read (the caller's platform identities), nothing per board");
  assert.match(src, /FROM stream\.links WHERE canonical = ANY\(\$1::text\[\]\)/);
  assert.match(src, /\}\s*$/); // END anchor
});
