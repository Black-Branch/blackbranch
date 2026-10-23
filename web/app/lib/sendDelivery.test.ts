// What a platform's answer means, and what the sender is told about a line that
// reached the site but not a platform. Behavioural: every function here is pure.
//
// Run: node --test app/lib/sendDelivery.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  twitchSendOutcome, kickSendOutcome, refusalByClass, describeDelivery,
  undeliveredLabel, deliveryFailureKind, skipPlatformsFrom,
  youtubeErrorOutcome, httpUnavailable, thrownFailure, failureOf,
} from "./sendDelivery.ts";

test("Twitch: is_sent:false is a refusal, with the drop reason as a phrase", () => {
  const followers = { data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_followersonly", message: "This room is in followers-only mode." } }] };
  assert.deepEqual(twitchSendOutcome(followers), { sent: false, reason: "followers-only" });
  const dup = { data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_duplicate", message: "x" } }] };
  assert.deepEqual(twitchSendOutcome(dup), { sent: false, reason: "duplicate message" });
  const automod = { data: [{ message_id: "", is_sent: false, drop_reason: { code: "msg_rejected", message: "x" } }] };
  assert.deepEqual(twitchSendOutcome(automod), { sent: false, reason: "held by AutoMod" });
});

test("Twitch: an unknown drop code falls back to the platform's own sentence, tidied", () => {
  const odd = { data: [{ is_sent: false, drop_reason: { code: "msg_something_new", message: "  Your message\nwas <b>dropped</b>. " } }] };
  assert.deepEqual(twitchSendOutcome(odd), { sent: false, reason: "Your message was b dropped /b ." });
  assert.deepEqual(twitchSendOutcome({ data: [{ is_sent: false }] }), { sent: false, reason: undefined },
    "no reason given → no parenthesis, never an invented one");
});

test("Twitch: a sent message is a success carrying its id", () => {
  assert.deepEqual(twitchSendOutcome({ data: [{ message_id: "abc", is_sent: true }] }), { sent: true, id: "abc" });
  assert.deepEqual(twitchSendOutcome(null), { sent: true }, "an unreadable 2xx body is not evidence of a refusal");
});

test("Kick: is_sent:false is a refusal; a sentence is mapped to a phrase", () => {
  assert.deepEqual(kickSendOutcome({ data: { is_sent: false } }), { sent: false, reason: undefined });
  assert.deepEqual(kickSendOutcome({ message: "Chatroom is in followers only mode", data: { is_sent: false } }),
    { sent: false, reason: "followers-only" });
  assert.deepEqual(kickSendOutcome({ data: { is_sent: true, message_id: 42 } }), { sent: true, id: "42" });
});

test("Kick: a 4xx with a sentence is a refusal; 401/404/5xx/no sentence are not", () => {
  assert.deepEqual(refusalByClass(400, { message: "You must follow this channel to chat" }), { refused: true, reason: "followers-only" });
  assert.deepEqual(refusalByClass(403, { message: "You are banned from this chatroom" }), { refused: true, reason: "you're banned there" });
  assert.equal(refusalByClass(401, { message: "Unauthorized" }), null);
  assert.equal(refusalByClass(404, { message: "not found" }), null);
  assert.equal(refusalByClass(502, { message: "bad gateway" }), null);
  assert.equal(refusalByClass(400, null), null);
});

test("the copy: posted here, refused there — never 'message not sent'", () => {
  const text = describeDelivery({ posted: true, failed: [{ platform: "kick", error: "refused", reason: "followers-only" }] });
  assert.equal(text, "Posted here — Kick refused it (followers-only).");
  assert.doesNotMatch(text!, /not sent/i);
});

test("the copy: several platforms, each with its own story", () => {
  const text = describeDelivery({
    posted: true,
    failed: [
      { platform: "kick", error: "refused" },
      { platform: "twitch", error: "send_failed" },
      { platform: "youtube", error: "not_live" },
    ],
  });
  assert.equal(text, "Posted here — Kick refused it; couldn't reach Twitch; YouTube isn't live.");
});

test("the copy: a line that never reached the site says so", () => {
  assert.equal(describeDelivery({ posted: false, failed: [{ platform: "twitch", error: "send_failed" }] }),
    "Not sent — couldn't reach Twitch.");
  assert.equal(describeDelivery({ posted: true, failed: [] }), null, "nothing failed → nothing to say");
  assert.equal(describeDelivery({ posted: true }), null);
});

test("each failure kind has its own clause", () => {
  assert.match(describeDelivery({ posted: true, failed: [{ platform: "twitch", error: "missing_scope" }] })!, /re-linking/);
  assert.match(describeDelivery({ posted: true, failed: [{ platform: "twitch", error: "crosspost_locked" }] })!, /paused/);
  assert.match(describeDelivery({ posted: true, failed: [{ platform: "twitch", error: "command_native_only" }] })!, /commands aren't sent to Twitch/);
  assert.match(describeDelivery({ posted: true, failed: [{ platform: "kick", error: "not_linked" }] })!, /isn't linked/);
});

test("the line label", () => {
  assert.equal(undeliveredLabel(["kick"]), "not delivered to Kick");
  assert.equal(undeliveredLabel(["kick", "twitch"]), "not delivered to Kick, Twitch");
});

// ── Persistent vs transient ─────────────────────────────────────────────────
// A PERSISTENT refusal will refuse the next message too (the channel's mode, or
// the person's standing there): it is explained once and the platform is skipped.
// Everything else is TRANSIENT: shown, rate-limited, and tried again next time.

test("persistent: a refusal for the channel's mode or the sender's standing there", () => {
  // The reasons exactly as the senders produce them — Kick's sentence and Twitch's code.
  const kickFollowers = refusalByClass(400, { message: "You must follow this channel to chat." });
  assert.ok(kickFollowers?.refused);
  const kickReason = kickFollowers?.reason;
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: kickReason }), "persistent");
  for (const code of ["msg_followersonly", "msg_subsonly", "msg_banned", "msg_channel_suspended", "msg_verified_email", "msg_requires_verified_phone_number"]) {
    const out = twitchSendOutcome({ data: [{ is_sent: false, drop_reason: { code } }] });
    const reason = out.sent ? undefined : out.reason;
    assert.equal(deliveryFailureKind({ platform: "twitch", error: "refused", reason }), "persistent", code);
  }
  const kickBanned = kickSendOutcome({ message: "You are banned from this chat", data: { is_sent: false } });
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: kickBanned.sent ? undefined : kickBanned.reason }), "persistent");
});

test("transient: anything about THIS message, a passing state, or reaching the platform", () => {
  for (const reason of ["duplicate message", "slow mode", "held by AutoMod", "blocked term", "emote-only", "you're timed out there", "unique-chat mode", undefined, "Some sentence Kick wrote"]) {
    assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", ...(reason ? { reason } : {}) }), "transient", String(reason));
  }
  for (const error of ["not_live", "send_failed", "missing_scope", "not_linked", "crosspost_locked", "command_native_only", "something_new"]) {
    // A persistent-looking reason on a non-refusal is still not a refusal.
    assert.equal(deliveryFailureKind({ platform: "twitch", error, reason: "followers-only" }), "transient", error);
  }
});

test("skipPlatformsFrom: only routable platform ids, deduplicated, bounded; anything else is ignored", () => {
  assert.deepEqual(skipPlatformsFrom({ skip_platforms: ["kick", "twitch", "kick"] }), new Set(["kick", "twitch"]));
  assert.deepEqual(skipPlatformsFrom({ skip_platforms: ["kick", "all", "native", "matrix", 7, null, "", "KICK"] }), new Set(["kick"]),
    "only a routable platform id can be skipped — never 'all', the site, or junk");
  assert.deepEqual(skipPlatformsFrom({ skip_platforms: "kick" }), new Set(), "not an array → nothing skipped");
  assert.deepEqual(skipPlatformsFrom({}), new Set());
  assert.deepEqual(skipPlatformsFrom(null), new Set());
  const many = skipPlatformsFrom({ skip_platforms: Array.from({ length: 5000 }, () => "kick") });
  assert.deepEqual(many, new Set(["kick"]));
});

// ── Infrastructure ──────────────────────────────────────────────────────────
// A failure the viewer cannot act on — the platform's API quota, a rate limit,
// an upstream 5xx, a timeout, our own token/DB throw — is its own class, so the
// client can stay silent about it. The provider's own text never reaches the client.

// YouTube's answer to liveChat/messages.insert once the project's daily quota is spent.
const YT_QUOTA_BODY = JSON.stringify({ error: { code: 403, message: "The request cannot be completed because you have exceeded your <a href=\"/youtube/v3/getting-started#quota\">quota</a>.",
  errors: [{ message: "The request cannot be completed because you have exceeded your quota.", domain: "youtube.quota", reason: "quotaExceeded" }] } });

test("infrastructure: YouTube's 403 youtube.quota is `unavailable`, cause quota, provider code youtube.quota", () => {
  assert.deepEqual(youtubeErrorOutcome(403, YT_QUOTA_BODY), { error: "unavailable", reason: "quota", code: "youtube.quota" });
  // The reason alone, without the domain, is the same thing.
  assert.deepEqual(youtubeErrorOutcome(403, JSON.stringify({ error: { errors: [{ reason: "dailyLimitExceeded" }] } })),
    { error: "unavailable", reason: "quota", code: "youtube.quota" });
});

test("infrastructure: YouTube rate limits and 5xx; insufficient scope stays a re-link; anything else stays send_failed", () => {
  assert.deepEqual(youtubeErrorOutcome(403, JSON.stringify({ error: { errors: [{ domain: "youtube.liveChat", reason: "rateLimitExceeded" }] } })),
    { error: "unavailable", reason: "rate_limited", code: "youtube.rateLimitExceeded" });
  assert.deepEqual(youtubeErrorOutcome(429, ""), { error: "unavailable", reason: "rate_limited", code: "youtube.http_429" });
  assert.deepEqual(youtubeErrorOutcome(503, "<html>backend error</html>"), { error: "unavailable", reason: "upstream", code: "youtube.http_503" });
  assert.deepEqual(youtubeErrorOutcome(403, JSON.stringify({ error: { errors: [{ reason: "insufficientPermissions" }] } })), { error: "missing_scope" });
  assert.deepEqual(youtubeErrorOutcome(403, JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } })), { error: "send_failed" },
    "a 4xx with no words of its own → the generic line");
  assert.deepEqual(youtubeErrorOutcome(400, "not json"), { error: "send_failed" });
});

test("infrastructure: Twitch/Kick 429 and 5xx; other statuses are not infrastructure", () => {
  assert.deepEqual(httpUnavailable("twitch", 429), { error: "unavailable", reason: "rate_limited", code: "twitch.http_429" });
  assert.deepEqual(httpUnavailable("kick", 502), { error: "unavailable", reason: "upstream", code: "kick.http_502" });
  for (const s of [400, 401, 403, 404, 422]) assert.equal(httpUnavailable("kick", s), null, String(s));
});

test("infrastructure: a thrown send — our timeout, the network, our own token/DB throw", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  assert.deepEqual(thrownFailure(timeout), { error: "unavailable", reason: "timeout", code: "timeout" });
  assert.deepEqual(thrownFailure(new TypeError("fetch failed")), { error: "unavailable", reason: "upstream", code: "network" });
  assert.deepEqual(thrownFailure(new Error("decrypt failed: bad tag")), { error: "unavailable", reason: "internal", code: "exception" });
  assert.deepEqual(thrownFailure("a string"), { error: "unavailable", reason: "internal", code: "exception" });
});

test("infrastructure: its own class, and the provider code never reaches the client", () => {
  const quota = youtubeErrorOutcome(403, YT_QUOTA_BODY);
  const f = failureOf("youtube", quota);
  assert.deepEqual(f, { platform: "youtube", error: "unavailable", reason: "quota" }, "the code is for the journal only");
  assert.equal(deliveryFailureKind(f), "infrastructure");
  assert.equal(deliveryFailureKind({ platform: "youtube", error: "unavailable" }), "infrastructure");
  // The persistent and transient classes are untouched by it.
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: "followers-only" }), "persistent");
  assert.equal(deliveryFailureKind({ platform: "twitch", error: "not_live" }), "transient");
  assert.equal(deliveryFailureKind({ platform: "twitch", error: "refused", reason: "you're timed out there" }), "transient",
    "a moderator's timeout there is passing and about the viewer — transient, not infrastructure");
  // If one ever reaches the copy, it is plain — no cause, no code, no quota.
  assert.equal(describeDelivery({ posted: true, failed: [f] }), "Posted here — couldn't reach YouTube.");
});
