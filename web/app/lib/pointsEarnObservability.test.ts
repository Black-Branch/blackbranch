// Points earn failures must be VISIBLE.
//
// An earn path that ends in a bare `.catch(() => {})` turns a schema change, a
// pool exhaustion or a bug in coinsServer into silently zeroed viewer earning —
// indistinguishable from a quiet stream (and a counter nobody reads is no
// remedy). The journal line is the reader here: it lands in the web service's
// journal, which is what gets read when "earning seems off".
//
// Source scans (both files import the auth/pg stack) with vacuity anchors.
//
// Run: node --test app/lib/pointsEarnObservability.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("the chat-message earn logs its failures", () => {
  const src = read("app/api/chat/send/route.ts");
  const fn = src.slice(src.indexOf("function maybeEarnChatCoin"), src.indexOf("export async function POST"));
  assert.ok(fn.length > 0, "vacuity anchor: maybeEarnChatCoin is gone");
  assert.doesNotMatch(fn, /\.catch\(\(\)\s*=>\s*\{\}\)/,
    "a bare swallow on the earn path — an earning outage becomes indistinguishable from a quiet stream");
  assert.match(fn, /\.catch\(\(e\) =>\s*console\.error/, "the catch must put the failure in the journal");
});

test("both vote earns log their failures", () => {
  const src = read("app/api/chat/vote/route.ts");
  assert.match(src, /earnVoteCast/, "vacuity anchor: the vote-cast earn is gone");
  assert.match(src, /earnUpvoteReceived/, "vacuity anchor: the upvote-received earn is gone");
  for (const call of ["earnVoteCast", "earnUpvoteReceived"]) {
    const at = src.indexOf(call);
    const stmt = src.slice(at, src.indexOf(";", at));
    assert.doesNotMatch(stmt, /\.catch\(\(\)\s*=>\s*\{\}\)/, `${call} swallows its failures silently`);
    assert.match(stmt, /\.catch\(\(e\) =>\s*console\.error/, `${call} must put the failure in the journal`);
  }
});
