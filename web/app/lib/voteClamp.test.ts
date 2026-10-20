// The per-target vote clamp — the anti-brigading limit.
//
// A bot upvoting or downvoting particular people needs clamping. A limit of 40
// votes/60s per voter counted across ALL messages cannot see brigading: 40/min
// spent entirely on one person looks exactly like 40/min spread across a
// lively chat. One account could bury one person and nothing would notice.
//
// That matters more than a vote count suggests — social credit is SUM(vote),
// recomputed on every read and rendered PUBLICLY on every UserCard, and it is
// the same currency the redacted-message gate spends against.
//
// The limiter itself is exercised for real here (it is pure, in-process, and
// takes a key); the wiring is asserted at the source level, because the ORDER
// the checks run in is the part that is easy to get wrong and impossible to see
// from the outside.
//
// Run: node --test app/lib/voteClamp.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSlidingWindowLimiter } from "./rateLimit.ts";
import { stripComments } from "./testSource.ts";
import {
  VOTE_TARGET_WINDOW_MS, VOTE_TARGET_MAX, VOTE_COOLING_TITLE,
} from "./votePolicy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));


const route = stripComments(readFileSync(join(HERE, "../api/chat/vote/route.ts"), "utf8"));

test("two votes on one target pass, the third is refused", () => {
  const limited = createSlidingWindowLimiter(30_000, 2);
  assert.equal(limited("alice->bob"), false, "1st vote on bob");
  assert.equal(limited("alice->bob"), false, "2nd vote on bob");
  assert.equal(limited("alice->bob"), true, "3rd vote on bob within 30s is refused");
});

test("the clamp is per TARGET — voting on other people is unaffected", () => {
  // THE property. A reader working down a busy chat votes on many different
  // authors; a bot hammers one. Keyed per-voter-only this would throttle the
  // reader, and keyed per-message it would miss the bot entirely (it would just
  // walk down the target's backlog one message at a time).
  const limited = createSlidingWindowLimiter(30_000, 2);
  limited("alice->bob");
  limited("alice->bob");
  assert.equal(limited("alice->bob"), true, "bob is now clamped for alice");
  assert.equal(limited("alice->carol"), false, "…but carol is not");
  assert.equal(limited("dave->bob"), false, "…and dave can still vote on bob");
});

test("the clamp is keyed voter->author, not voter->message", () => {
  assert.match(route, /isTargetVoteLimited\(`\$\{matrixId\}->\$\{author\}`\)/,
    "keying on the message id would let a bot walk down someone's backlog");
});

test("clearing a vote is exempt — undo must never be rate-limited", () => {
  // A clamp on `vote === 0` strands someone on a mis-tap they can see and
  // cannot take back, and it buys nothing: clearing only ever moves a score
  // back toward zero, so it cannot brigade.
  assert.match(route, /if \(vote !== 0 && author\) \{/,
    "the clamp must exempt the clear-vote case");
});

test("changing an existing vote is exempt — only NEW messages count", () => {
  // The property that keeps this from breaking ordinary voting.
  //
  // message_votes is keyed (platform, message_id, voter) and UPSERTS, so one
  // voter moves any single message by at most ±1 however many times they click.
  // Re-voting therefore cannot brigade — only reaching new messages by the same
  // author accumulates. Meanwhile up→down→up on one message is three calls in
  // seconds, and the client reverts silently on 429 — which reads as "voting
  // broke" under too tight a GLOBAL limit (hence 40/60s, not 10/60s).
  assert.match(route, /SELECT 1 FROM site\.message_votes/,
    "the route must check for an existing vote before clamping");
  assert.match(route, /already\.rows\.length === 0 && isTargetVoteLimited\(/,
    "the clamp must only arm when this is a NEW message for this voter");
  // The upsert is what makes the exemption safe — assert it is still an upsert.
  assert.match(route, /ON CONFLICT \(platform, message_id, voter_matrix_id\)\s*\n?\s*DO UPDATE/,
    "if this stopped upserting, re-voting could accumulate and the exemption would be a hole");
});

test("the clamp runs after the self-vote refusal and before any write", () => {
  // Ordering, asserted because both mistakes are silent.
  //   • BEFORE the self-vote check: a refused self-vote would burn the voter's
  //     own allowance against themselves.
  //   • AFTER the write: the vote has already landed; the limiter is decoration.
  const selfVote = route.indexOf('error: "self_vote"');
  const clamp = route.indexOf("isTargetVoteLimited(");
  // Anchor on the WRITE, not on the table name. The exemption check runs a
  // `SELECT 1 FROM site.message_votes` ahead of the clamp, so a bare
  // indexOf("site.message_votes") finds the read and the assertion inverts —
  // it fails on correct code.
  const write = Math.min(
    ...["INSERT INTO site.message_votes", "DELETE FROM site.message_votes"]
      .map((s) => route.indexOf(s))
      .filter((i) => i !== -1)
  );
  assert.ok(selfVote !== -1 && clamp !== -1 && Number.isFinite(write), "all three sites must exist");
  assert.ok(selfVote < clamp, "the clamp must run after the self-vote refusal");
  assert.ok(clamp < write, "the clamp must run before the vote is written");
});

test("the global limiter is still there — this ADDS a limit, it does not replace one", () => {
  // The two answer different questions: the global one bounds total volume, the
  // per-target one bounds concentration. Dropping either reopens a hole.
  // Anchored on the NAMED constants, not the literals. The numbers live in
  // votePolicy.ts because the refusal's user-facing message has to state them
  // — a number typed twice drifts, and a composer saying "every 5 minutes"
  // after the cooldown became 2 is that drift. The invariant is "both limiters
  // are wired up", which never depended on the values being typed here.
  assert.match(route, /createSlidingWindowLimiter\(VOTE_GLOBAL_WINDOW_MS, VOTE_GLOBAL_MAX\)/,
    "global volume limit");
  assert.match(route, /createSlidingWindowLimiter\(VOTE_TARGET_WINDOW_MS, VOTE_TARGET_MAX\)/,
    "per-target concentration limit");
  assert.match(route, /if \(isVoteRateLimited\(matrixId\)\)/, "and the global one is still applied");
});

test("the clamp's numbers are single-sourced, and the copy derives from them", () => {
  // The values are USER-FACING: the refusal tooltip states them. A second
  // copy of the number is a sentence that will eventually lie to people.
  assert.equal(VOTE_TARGET_MAX, 2);
  assert.equal(VOTE_TARGET_WINDOW_MS, 30_000);
  // The sentence must be BUILT from the constants, so changing one changes both.
  assert.ok(VOTE_COOLING_TITLE.includes(String(VOTE_TARGET_MAX)),
    "the refusal message does not mention the real vote allowance");
  assert.ok(VOTE_COOLING_TITLE.includes(String(VOTE_TARGET_WINDOW_MS / 1000)),
    "the refusal message does not mention the real window");
  // And the route must not have grown a fresh literal behind the constants' back.
  assert.doesNotMatch(route, /createSlidingWindowLimiter\(\s*\d/,
    "a rate limit in this route was re-typed as a literal instead of using votePolicy");
});

test("a refused vote is actually shown to the voter", () => {
  // The clamp shipped returning 429 with nothing on the client reading it — the
  // optimistic score simply reverted, so a rate-limited viewer saw the arrow
  // bounce back and concluded the button was broken. There is no toast system
  // (removed in the one-card sweep), so the refusal surfaces in place.
  const hook = stripComments(readFileSync(join(HERE, "useChatMessages.ts"), "utf8"));
  assert.match(hook, /e instanceof HttpError && e\.status === 429/,
    "the vote handler no longer distinguishes a refusal from any other failure");
  assert.match(hook, /_voteCooling: on/, "…and no longer marks the row");
  const msg = stripComments(readFileSync(join(HERE, "../features/chat/ChatMessage.tsx"), "utf8"));
  assert.match(msg, /VOTE_COOLING_TITLE/,
    "the vote control does not explain the refusal");
});
