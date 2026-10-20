// GET /api/user/[id] is public: only the card's fields of stream-api's lookup may leave.
// Run: node --test app/lib/publicProfile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicProfileFields } from "./publicProfile.ts";
import { stripComments } from "./testSource.ts";
import { profileExtras as noPlugin } from "./plugins/absent/profile.ts";

// The shape stream-api /user/lookup answers with (profiles.js), plus an owner-plugin extra (a made-up name: the real field is dropped the same way, as anything unlisted is).
const lookup = {
  canonicalId: "0123456789ab", name: "casey", karma: 12.5, activity: 40, streams: 9,
  support: 1234.56, isMember: true, subTier: "t1", camp: "Gadget", temperamentLabel: "Gadget",
  labelRank: 3, labelCount: 20, variance: 0.4, extremePct: 5, intelligence: 0.71,
  intelligenceTier: "sharp", intelLabelRank: 2, intelLabelCount: 11, wordCountTier: "chatty",
  supportTier: "regular", regularityTier: "weekly", avgMessageWords: 7.2,
  botImpression: "likes trains; mentioned their hometown",
};

test("the exact support total and the bot's read on the person never leave", () => {
  const out = publicProfileFields(lookup);
  assert.equal("support" in out, false);
  assert.equal("botImpression" in out, false);
});

test("a field stream-api or a plugin adds later stays private until it is listed", () => {
  assert.equal("somethingNew" in publicProfileFields({ ...lookup, somethingNew: "x" }), false);
});

test("exactly the fields the card renders go out — no scoring read on the person", () => {
  // The owner decided the AI scoring fields (camp, temperament, label rank, intelligence / word
  // count / regularity tiers, average words) stay off the public card, like the bot's impression.
  assert.deepEqual(Object.keys(publicProfileFields(lookup)).sort(), [
    "activity", "isMember", "karma", "name", "streams", "subTier", "supportTier",
  ]);
  for (const k of ["camp", "temperamentLabel", "labelRank", "labelCount", "intelligenceTier", "wordCountTier", "regularityTier", "avgMessageWords"]) {
    assert.equal(k in publicProfileFields(lookup), false, `${k} must stay private`);
  }
  assert.equal(publicProfileFields(lookup).karma, 12.5);
  assert.deepEqual(publicProfileFields({}), {});
});

// An installed owner plugin may forward extra lookup fields its own pill needs (ProfileExtras
// publicFields, read through the @owner/profile seam). The public product carries no plugin.
test("no plugin (the public product): exactly the product's fields go out", () => {
  const fields = noPlugin.publicFields ?? [];
  assert.deepEqual(fields, [], "the no-plugin seam declares fields");
  assert.deepEqual(publicProfileFields(lookup, fields), publicProfileFields(lookup));
  assert.equal("temperamentLabel" in publicProfileFields(lookup, fields), false);
});

test("a plugin declaring one field: that field is forwarded, nothing else", () => {
  const out = publicProfileFields(lookup, ["temperamentLabel"]);
  assert.deepEqual(Object.keys(out).sort(), ["activity", "isMember", "karma", "name", "streams", "subTier", "supportTier", "temperamentLabel"]);
  assert.equal(out.temperamentLabel, "Gadget");
  assert.equal("camp" in out, false);
});

test("the exact support total and the canonical id are never forwarded, whatever a plugin declares", () => {
  const out = publicProfileFields(lookup, ["support", "canonicalId", "botImpression"]);
  assert.equal("support" in out, false);
  assert.equal("canonicalId" in out, false);
  assert.equal(out.botImpression, "likes trains; mentioned their hometown", "a declared plugin field is the plugin's to forward");
});

test("the route forwards the installed plugin's fields, only with the merged stats", () => {
  const raw = readFileSync(join(process.cwd(), "app", "api", "user", "[id]", "route.ts"), "utf8");
  assert.match(raw, /\}\);\n\}\n$/, "END of route.ts not read");
  assert.match(raw, /import \{ pluginProfileFields \} from "@\/app\/lib\/plugins\/profile";/);
  assert.match(raw, /const fields = view\.links \? publicProfileFields\(data, pluginProfileFields\(\)\) : identityStats;/);
  // A stranger never gets a plugin field — not even for a single identity, where a real value would
  // mean "not linked" and an active person's missing one would hint "linked" (D1). The non-links
  // branch is the one identity's stats and nothing else.
  assert.match(raw, /\? publicProfileFields\(data, pluginProfileFields\(\)\) : identityStats;\n/);
  assert.doesNotMatch(stripComments(raw), /single|strangerProfileFields|isSingleIdentity/, "a single-identity path to the plugin's fields came back");
  const seam = readFileSync(join(process.cwd(), "app", "lib", "plugins", "profile.ts"), "utf8");
  assert.match(seam, /return profileExtras\.publicFields \?\? \[\];/);
});
