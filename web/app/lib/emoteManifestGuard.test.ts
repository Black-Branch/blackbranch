// Unit tests for the pure emote-manifest rebuild guard. Run with:
//   node --test app/lib/emoteManifestGuard.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceDecision, SHRINK_FLOOR, MIN_TRUST } from "./emoteManifestGuard.ts";

test("healthy fetch takes the fresh slice", () => {
  assert.equal(sliceDecision(1000, 1000, false), "fresh");
  assert.equal(sliceDecision(1005, 1000, false), "fresh"); // grew
});

test("small legitimate removal passes through (above the floor)", () => {
  assert.equal(sliceDecision(990, 1000, false), "fresh");
  assert.equal(sliceDecision(600, 1000, false), "fresh"); // 60% > 50% floor
});

test("drastic shrink is rejected as a truncated response (the 1150→178 case)", () => {
  assert.equal(sliceDecision(178, 1150, false), "keep-prev");
});

test("outright failure (slice collapses to 0) keeps last-good", () => {
  assert.equal(sliceDecision(0, 1000, false), "keep-prev");
});

test("cold start with no last-good takes whatever we get", () => {
  assert.equal(sliceDecision(0, 0, false), "fresh");
  assert.equal(sliceDecision(500, 0, false), "fresh");
});

test("force bypasses the shrink guard (intentional mass change / full purge)", () => {
  assert.equal(sliceDecision(178, 1150, true), "fresh");
  assert.equal(sliceDecision(0, 1000, true), "fresh");
});

test("small/new sets below MIN_TRUST are never guarded", () => {
  // Nothing worth protecting yet, so even a proportional collapse takes fresh.
  assert.equal(sliceDecision(0, MIN_TRUST - 1, false), "fresh");
  assert.equal(sliceDecision(1, MIN_TRUST - 1, false), "fresh");
});

test("the floor is a strict '<' boundary", () => {
  // freshCount < prevCount * SHRINK_FLOOR is strict, so exactly at the floor passes.
  assert.equal(sliceDecision(1000 * SHRINK_FLOOR, 1000, false), "fresh");
  assert.equal(sliceDecision(1000 * SHRINK_FLOOR - 1, 1000, false), "keep-prev");
});

// ─── Ticket #5: the mod refresh must be traceable, and must not hairpin ──────
//
// A mod's `/emotes refresh` failed with a bare "Refresh failed" and no record of
// why, then worked minutes later. Root cause of the untraceability: the mod
// route reached the rebuild by FETCHING ITS OWN PUBLIC URL — out through the
// Cloudflare tunnel and back into the same server — so any tunnel blip failed
// the command, and the caught error was discarded. These pin the shape that
// can't do that.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const readSrc = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));

test("the mod refresh calls the rebuild in-process — no self-fetch hairpin", () => {
  const modRoute = readSrc("app/api/mod/emotes/route.ts");
  assert.match(modRoute, /import \{ emoteAdminAction \} from "@\/app\/api\/emotes\/route"/,
    "the mod route must import the operation, not fetch it");
  assert.match(modRoute, /await emoteAdminAction\(/, "…and actually call it");
  assert.doesNotMatch(modRoute, /new URL\([`"']\/api\/emotes/,
    "the tunnel hairpin is back — a tunnel blip will fail the command untraceably again");
});

test("a failed refresh is logged with the real error, and the caller sees it", () => {
  const modRoute = readSrc("app/api/mod/emotes/route.ts");
  assert.match(modRoute, /console\.error\("\[mod\/emotes\]"/,
    "the journal must carry the real failure — 'it failed once, untraceably' is not enough");
  assert.match(modRoute, /Refresh failed: \$\{e instanceof Error \? e\.message/,
    "the chat-command caller gets the reason, not a bare 'Refresh failed'");
});

test("the check dry-run compares against what the site would SERVE, not the raw cache", () => {
  // After a restart the module cache is empty until the first GET builds it —
  // the raw read made `/emotes check` report `current: 0` against a site that
  // was serving emotes fine (the ticket's second oddity).
  const emotes = readSrc("app/api/emotes/route.ts");
  const check = emotes.slice(emotes.indexOf("if (opts.check)"), emotes.indexOf("refreshCooldown.hit(\"global\")"));
  assert.ok(check.length > 50, "could not bound the check branch");
  assert.match(check, /Object\.keys\(await getManifest\(\)\)/,
    "check must build/serve the manifest for its comparison base");
  assert.doesNotMatch(check, /manifest \?\? \{\}/,
    "the raw-cache read is back — a post-restart check will claim current: 0 again");
});
