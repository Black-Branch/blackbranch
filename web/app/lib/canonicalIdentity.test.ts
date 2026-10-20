// canonicalIdentity — a canonical stream id is not a matrix id, and the one
// place that mixed them up (the upvote award) now resolves first.
//
// Run: node --test app/lib/canonicalIdentity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { matrixIdForCanonical, linkedMatrixIds, type LinkQuery } from "./canonicalIdentity.ts";
import { NATIVE_SQL } from "./nativePlatform.ts";

const linked = (map: Record<string, string>): LinkQuery => async (_sql, params) => {
  const mx = map[String(params[0])];
  return { rows: mx ? [{ matrix_id: mx }] : [] };
};

test("only a 12-hex id is looked up; anything else is already a matrix id", async () => {
  const asked: unknown[] = [];
  const q: LinkQuery = async (_sql, params) => { asked.push(params[0]); return { rows: [] }; };
  assert.equal(await matrixIdForCanonical("fa1b2c3d4e5", q), "fa1b2c3d4e5", "11 hex is not a canonical");
  assert.equal(await matrixIdForCanonical("@casey:site.test", q), "@casey:site.test");
  assert.deepEqual(asked, [], "neither was looked up");
});

test("a linked canonical resolves to its site account; an unlinked one to null", async () => {
  const q = linked({ fa1b2c3d4e5f: "@casey:site.test" });
  assert.equal(await matrixIdForCanonical("fa1b2c3d4e5f", q), "@casey:site.test");
  assert.equal(await matrixIdForCanonical("FA1B2C3D4E5F", q), "@casey:site.test", "case-folded before the lookup");
  assert.equal(await matrixIdForCanonical("b2453bd16c38", q), null);
});

test("a matrix id passes straight through without a query", async () => {
  let asked = 0;
  const q: LinkQuery = async () => { asked++; return { rows: [] }; };
  assert.equal(await matrixIdForCanonical("@casey:site.test", q), "@casey:site.test");
  assert.equal(asked, 0);
});

test("a lookup that throws reads as unlinked, never as an error", async () => {
  const q: LinkQuery = async () => { throw new Error("pool gone"); };
  assert.equal(await matrixIdForCanonical("fa1b2c3d4e5f", q), null);
});

// ── The consumer that got it wrong ───────────────────────────────────────────
test("the vote route awards upvote Qorm to the RESOLVED recipient, never the raw author", () => {
  const src = stripComments(readFileSync(new URL("../api/chat/vote/route.ts", import.meta.url), "utf8"));
  const award = src.indexOf("earn.earnUpvoteReceived(");
  assert.ok(award > 0, "the award call exists");
  assert.match(src.slice(award, award + 80), /earnUpvoteReceived\(recipient, matrixId, platform, id\)/,
    "the recipient is the resolved id");
  const resolve = src.indexOf("matrixIdForCanonical(author");
  assert.ok(resolve > 0 && resolve < award, "the author is resolved through platform_links BEFORE the award");
  assert.match(src.slice(resolve, award), /recipient && recipient !== matrixId\s*\?/,
    "unlinked (no wallet) and self both skip");
  // END anchor: the route's final response follows the award block — a truncated read fails here.
  assert.ok(src.lastIndexOf("return Response.json") > award, "the read reached the route's end");
});

test("linkedMatrixIds throws on a failed lookup, so a ceiling built on it can fail closed", async () => {
  const q: LinkQuery = async () => { throw new Error("pool gone"); };
  await assert.rejects(linkedMatrixIds("e5258f38b98c", q), /pool gone/);
  assert.deepEqual(await linkedMatrixIds("@casey:site.test", q), ["@casey:site.test"], "a matrix id needs no lookup");
});

// R2-7: a site account's own (native) canonical lives in stream.links, not
// site.platform_links. Missing it made an owner who never linked a platform
// read as an unlinked chatter to the moderation ceiling.
test("linkedMatrixIds reads the native stream.links rows AND platform_links, and returns every account", async () => {
  const seen: string[] = [];
  const q: LinkQuery = async (sql, params) => {
    seen.push(sql);
    assert.equal(params[0], "fa1b2c3d4e5f", "case-folded before the lookup");
    const rows: { matrix_id: string }[] = [];
    if (sql.includes("site.platform_links")) rows.push({ matrix_id: "@sam:site.test" });
    if (/stream\.links[\s\S]*platform IN /.test(sql) && sql.includes(NATIVE_SQL)) rows.push({ matrix_id: "@casey:site.test" }, { matrix_id: "@sam:site.test" });
    return { rows };
  };
  assert.deepEqual(await linkedMatrixIds("FA1B2C3D4E5F", q), ["@sam:site.test", "@casey:site.test"],
    "a native-only account was missed, or a duplicate kept");
  assert.equal(seen.length, 1, "one query answers both tables");
  assert.equal(await matrixIdForCanonical("fa1b2c3d4e5f", q), "@sam:site.test", "the vote award still takes the first account");
});

test("admin's moderation ceiling goes through the shared, fail-closed check", () => {
  const src = stripComments(readFileSync(new URL("./admin.ts", import.meta.url), "utf8"));
  assert.match(src, /export function assertCanModerate[\s\S]*?return checkModerationCeiling\(actorId, target,/);
  assert.ok(src.lastIndexOf("export async function requireMod") > src.indexOf("checkModerationCeiling("), "the read reached requireMod");
});
