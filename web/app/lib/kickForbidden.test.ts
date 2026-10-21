// How a platform's chat failures are classified:
//  - Kick's bare 403 "Forbidden" is classified per channel: followers-only → a viewer-actionable
//    refusal (one note per session); not known → silent, logged by shape only.
//  - a known refusal sentence on a 429 is the channel's mode, not infrastructure.
//  - a YouTube /live page that could not be read is "unavailable", not "not live".
//  - a TypeError from our own code is silent to viewers but its stack is logged, rate-limited.
// Run: node --test app/lib/kickForbidden.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kickForbiddenOutcome, kickKnownRefusal, bodyShape, thrownFailure, deliveryFailureKind, failureOf, FOLLOWERS_ONLY } from "./sendDelivery.ts";

const KICK_403 = { data: {}, message: "Forbidden" };

test("a bare Kick 403 on a followers-only channel is a followers-only refusal — persistent, one note per session", () => {
  assert.equal(kickKnownRefusal(KICK_403), null, "'Forbidden' names no known refusal by itself");
  const out = kickForbiddenOutcome(true);
  assert.deepEqual(out, { refused: true, reason: FOLLOWERS_ONLY });
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: FOLLOWERS_ONLY }), "persistent");
});

test("a bare Kick 403 where the channel is not followers-only, or its mode is unknown, is never assumed: silent infrastructure", () => {
  for (const fo of [false, null]) {
    const out = kickForbiddenOutcome(fo);
    assert.deepEqual(out, { error: "unavailable", reason: "upstream", code: "kick.http_403" });
    assert.equal(deliveryFailureKind(failureOf("kick", out as { error: string; reason?: string })), "infrastructure");
  }
});

test("a known refusal sentence wins over the status: a 429 saying 'slow mode' is the channel's mode", () => {
  assert.equal(kickKnownRefusal({ message: "Chatroom is in slow mode, please wait" }), "slow mode");
  assert.equal(kickKnownRefusal({ message: "You must follow this channel to chat" }), FOLLOWERS_ONLY);
  assert.equal(kickKnownRefusal({ message: "Too Many Requests" }), null, "a bare rate-limit sentence stays infrastructure");
  assert.equal(kickKnownRefusal(null), null);
});

test("the log line carries the body's shape, never its text", () => {
  assert.equal(bodyShape(KICK_403), "{data:{},message:string}");
  assert.equal(bodyShape({ error: { errors: [{ reason: "x" }] } }), "{error:{errors:[…]}}");
  assert.doesNotMatch(bodyShape({ message: "casey said hi" }), /casey/);
});

test("a TypeError from our own code is internal, silent, and its stack is logged once per 10 minutes (retry: the second throw is quiet)", () => {
  const lines: string[] = [];
  const log = { error: (l: string) => lines.push(l) };
  const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
  assert.deepEqual(thrownFailure(bug, 1_000, log), { error: "unavailable", reason: "internal", code: "type_error" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /Cannot read properties of undefined/);
  thrownFailure(bug, 60_000, log);
  assert.equal(lines.length, 1, "a repeat inside 10 minutes is not logged");
  thrownFailure(bug, 1_000 + 10 * 60_000, log);
  assert.equal(lines.length, 2, "after 10 minutes it is logged again");
  // fetch's own network failure is still the network, and logs nothing.
  assert.deepEqual(thrownFailure(new TypeError("fetch failed"), 0, log), { error: "unavailable", reason: "upstream", code: "network" });
  assert.equal(lines.length, 2);
});

test("wiring: the Kick sender checks a known sentence first, then the status, then the channel's mode for a bare 403, and logs only shapes", () => {
  const src = readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8");
  const known = src.indexOf("const known = kickKnownRefusal(body);");
  const down = src.indexOf('const down = httpUnavailable("kick", res.status);');
  const forb = src.indexOf("kickForbiddenOutcome(await kickFollowersOnly(");
  assert.ok(known > 0 && down > known && forb > down, "order: known sentence → infrastructure → per-channel 403");
  assert.doesNotMatch(src, /console\.error\("\[platformChat:kick\]", res\.status, text\)/, "the body text is no longer logged");
  assert.match(src, /chatroom\?\.followers_mode/);
  // YouTube: an unread /live page with no earlier video is unavailable, not "not live".
  assert.match(src, /if \(!videoId && !pageRes\?\.ok\) \{/);
  assert.match(src, /code: "youtube\.live_page" \}/);
  assert.match(src.trimEnd(), /\}$/);
});
