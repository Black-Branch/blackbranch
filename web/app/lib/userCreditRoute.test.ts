// /api/user/credit is public. It summed a person's credit across every linked identity for any
// id, so a person's Twitch card and YouTube card showed the same total — the cross-platform link,
// published. The merged total now follows the profile card's rule (linkFactsServer.ts); anyone
// else gets one identity's credit. Source scan (the route's aliased imports keep it out of
// node --test); getSocialCredit's platform filter is pinned as SQL text.
// Run: node --test app/lib/userCreditRoute.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const src = stripComments(readFileSync(join(process.cwd(), "app", "api", "user", "credit", "route.ts"), "utf8"));
const lib = stripComments(readFileSync(join(process.cwd(), "lib", "socialCredit.ts"), "utf8"));

test("the merged total only for the person, a moderator, or an opt-in", () => {
  assert.match(src, /const full = isMod \|\| isSelf \|\| owner\?\.show_links === true;\s*if \(full\) \{\s*const ids = await resolveIdentities\(/);
  assert.equal((src.match(/resolveIdentities\(/g) ?? []).length, 1, "a second, ungated merged read");
});

test("a stranger reading a platform identity gets that platform's lines only", () => {
  assert.match(src, /getSocialCredit\(\{ matrixIds: \[\], canonicalIds: \[pub\.canonical\] \}, pub\.platform\)/);
  assert.match(lib, /AND \(\$3::text IS NULL OR lower\(cl\.platform\) = \$3\)/);
  assert.match(lib, /\[ids\.matrixIds, ids\.canonicalIds, platform \? platform\.toLowerCase\(\) : null\]/);
});

test("a split identity: the person's own credit is counted from THEIR account, not another sharing the canonical", () => {
  // linkFacts' third argument makes LINK_OWNER_SQL prefer the caller's own account (run on a real
  // Postgres in profileView.test.ts, "a split identity"); the merged read then starts from it.
  assert.match(src, /const \{ viewer, isMod, isSelf \} = await viewerFacts\(canonical, matrixKey\);/);
  assert.match(src, /const \{ owner \} = await linkFacts\(canonical, matrixKey, isSelf \? viewer : null\);/);
  assert.match(src, /resolveIdentities\(\{ matrixId: matrixKey \?\? owner\?\.matrix_id \?\? null, canonicalId: canonical \}\)/);
});

test("a raw canonical is answered only for a moderator or the person", () => {
  assert.match(src, /if \(legacyCanonical && !isMod && !isSelf\) return Response\.json\(\{ credit: 0 \}\);/);
  assert.match(src, /return Response\.json\(\{ credit: 0 \}\);\s*\}\s*\}\s*$/, "END anchor");
});
