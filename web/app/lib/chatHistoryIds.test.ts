// The public chat history (no sign-in) never carries a canonical id (owner decision 2026-10-17):
// it returned canonical_id + matrix_id per row back to the start of chat, so a script could group
// every person's Twitch, YouTube, Kick and site lines. Rows now carry a per-platform public id; a
// moderator's page also carries the canonical; a platform row never carries a Matrix id.
// Run: node --test app/lib/chatHistoryIds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { historyIds } from "./chatHistoryIds.ts";
import { stripComments } from "./testSource.ts";

const make = (c: string | null | undefined, p: string) => (c ? `p:${c}:${p}` : null);

test("a viewer's row: the per-platform public id, no canonical", () => {
  const tw = historyIds({ canonical_id: "0a1b2c3d4e5f", matrix_id: null, platform: "twitch" }, false, make);
  const yt = historyIds({ canonical_id: "0a1b2c3d4e5f", matrix_id: null, platform: "youtube" }, false, make);
  assert.equal("canonicalId" in tw, false);
  assert.notEqual(tw.publicId, yt.publicId);
  assert.equal(tw.matrixId, null);
});

test("a site row keeps its own Matrix id; a platform row never carries one", () => {
  const site = historyIds({ canonical_id: "0a1b2c3d4e5f", matrix_id: "@casey:site.test", platform: "native" }, false, make);
  assert.equal(site.matrixId, "@casey:site.test");
  assert.equal(site.publicId, "p:0a1b2c3d4e5f:native");
  const plat = historyIds({ canonical_id: "0a1b2c3d4e5f", matrix_id: "@casey:site.test", platform: "kick" }, false, make);
  assert.equal(plat.matrixId, null);
});

test("a moderator's row also carries the canonical", () => {
  const ids = historyIds({ canonical_id: "0a1b2c3d4e5f", platform: "twitch" }, true, make);
  assert.equal(ids.canonicalId, "0a1b2c3d4e5f");
});

const route = stripComments(readFileSync(join(process.cwd(), "app", "api", "chat", "history", "route.ts"), "utf8"));

test("the route builds every message row's ids through historyIds, and a card's stored canonical only for a mod", () => {
  assert.match(route, /\.\.\.historyIds\(r, isMod, publicIdFor\),/);
  assert.doesNotMatch(route, /canonicalId: r\.canonical_id/, "a row copies the canonical straight out");
  assert.match(route, /\.\.\.\(isMod && typeof storedCanonical === "string" \? \{ canonicalId: storedCanonical \} : \{\}\)/);
  assert.match(route, /AND ol\.platform NOT IN \$\{NATIVE_SQL\} AND ol\.platform <> combined\.platform/,
    "a platform row's avatar is drawn only when the person has no other platform");
  assert.match(route, /return \{ messages: messages as \(ChatMsg & \{ cts: string \}\)\[\], hasMore: rows\.length >= limit \};\s*\}\s*$/,
    "vacuity anchor: the scan reached the end of route.ts");
});
