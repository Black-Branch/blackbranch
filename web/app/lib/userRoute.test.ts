// Static guards on app/api/user/[id]/route.ts — the public profile lookup the UserCard/ProfileCard
// read. The disclosure decision itself (who sees the link, merged stats, the site account) is
// pinned behaviourally in profileView.test.ts; these pin the route's shape around it.
//
// Run: node --test app/lib/userRoute.test.ts
//
// The regression the first two pin: the site-identity enrichment used to sit in the SAME try/catch
// as the stream-api lookup, so a throw on it fell through to `{ found: false }` and blanked a real
// profile. The payload is computed first and the enrichment can only ADD.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const raw = readFileSync(join(process.cwd(), "app", "api", "user", "[id]", "route.ts"), "utf8");
const src = stripComments(raw);

test("the lookup's fields reach the response only through the allowlist", () => {
  assert.match(src, /const fields = view\.links \? publicProfileFields\(data, pluginProfileFields\(\)\) : identityStats;/);
  assert.doesNotMatch(src, /\.\.\.data\b/, "the raw lookup (support total, plugin extras) is never spread");
  assert.match(raw, /\}\);\n\}\n$/, "END of route.ts not read");
});

test("link enrichment cannot discard the profile payload", () => {
  const idx = src.indexOf("let linkedPlatforms");
  assert.ok(idx > 0, "the linked-identity enrichment branch is gone");
  assert.ok(idx > src.lastIndexOf("found: false"),
    "a found:false return sits after the enrichment — a throw there would blank the card");
  assert.match(src.slice(idx), /catch\s*\{/, "the enrichment lost its isolating try/catch");
});

test("handles come from chat_log, keyed by the canonical, for moderators only", () => {
  assert.match(src, /DISTINCT ON \(platform\)[\s\S]*FROM stream\.chat_log/);
  assert.match(src, /WHERE user_id = \$1 AND username IS NOT NULL/);
  const enrichIdx = src.indexOf("let platformHandles");
  const catchIdx = src.indexOf("catch", src.indexOf("platformHandles = rows.map"));
  assert.ok(enrichIdx !== -1 && catchIdx > enrichIdx, "the handle query must be covered by the enrichment catch");
});

test("a platform card names the identity by its own platform's name", () => {
  assert.match(src, /WHERE user_id = \$1 AND lower\(platform\) = \$2 AND username IS NOT NULL/);
  assert.match(src, /\.\.\.\(platformName \? \{ name: platformName \} : \{\}\),/);
});

test("the erased-person row has no profile", () => {
  assert.match(src, /if \(canonicalId === ERASED_CANONICAL\) return Response\.json\(\{ found: false \}\);/);
});
