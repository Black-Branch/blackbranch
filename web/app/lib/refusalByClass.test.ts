// A platform's refusal is recognised by its CLASS, not by a list of sentences we
// have already seen: any 4xx that carries the platform's own words is the
// platform declining the message, and the sender sees those words. Only network
// errors and 5xx are infrastructure (silent, #184). A 4xx with no words falls back
// to the generic line.
//
// The defect this pins: Kick answered `400 {"data":"MAX_SPECIAL_CHARS_ERROR"}`
// (11 times on 2026-10-19). Its words sit in `data`, not `message`, so the old
// known-sentence reader found nothing and the sender was told "couldn't reach
// Kick" instead of what Kick said.
//
// Run: node --test app/lib/refusalByClass.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  refusalByClass, youtubeErrorOutcome, kickSendOutcome, describeDelivery,
  deliveryFailureKind, FOLLOWERS_ONLY, BANNED_THERE,
} from "./sendDelivery.ts";
import { stripComments } from "./testSource.ts";

const SPECIAL = { data: "MAX_SPECIAL_CHARS_ERROR" };

test("a body-bearing 4xx reaches the sender verbatim: Kick's MAX_SPECIAL_CHARS_ERROR in `data`", () => {
  const out = refusalByClass(400, SPECIAL);
  assert.deepEqual(out, { refused: true, reason: "MAX_SPECIAL_CHARS_ERROR" });
  const text = describeDelivery({ posted: true, failed: [{ platform: "kick", error: "refused", reason: out!.reason }] });
  assert.equal(text, "Posted here — Kick refused it (MAX_SPECIAL_CHARS_ERROR).");
});

test("any 4xx sentence is a refusal, whatever its status and whichever field carries it", () => {
  assert.deepEqual(refusalByClass(422, { message: "Message contains a word that is not allowed" }),
    { refused: true, reason: "Message contains a word that is not allowed" });
  // Twitch's Helix error shape: { error, status, message }.
  assert.deepEqual(refusalByClass(400, { error: "Bad Request", status: 400, message: "The message is too long" }),
    { refused: true, reason: "The message is too long" });
  // YouTube / Google: { error: { code, message } }.
  assert.deepEqual(refusalByClass(403, { error: { code: 403, message: "The live chat is no longer live." } }),
    { refused: true, reason: "The live chat is no longer live." });
  assert.deepEqual(refusalByClass(400, { error: "Some plain error string" }), { refused: true, reason: "Some plain error string" });
  // A 429 that SAYS something about the channel is the channel's mode.
  assert.deepEqual(refusalByClass(429, { message: "Chatroom is in slow mode, please wait" }),
    { refused: true, reason: "Chatroom is in slow mode, please wait" });
});

test("a 5xx is never a refusal, whatever it says: infrastructure stays silent", () => {
  for (const s of [500, 502, 503, 504]) assert.equal(refusalByClass(s, { message: "Something broke" }), null, String(s));
  assert.equal(refusalByClass(200, { message: "ok" }), null);
});

test("a 4xx with no body, or only an HTTP reason phrase, falls back to the generic line", () => {
  assert.equal(refusalByClass(400, null), null);
  assert.equal(refusalByClass(400, "not json"), null);
  assert.equal(refusalByClass(400, {}), null);
  assert.equal(refusalByClass(400, { data: {} }), null);
  assert.equal(refusalByClass(400, { message: "   " }), null);
  // "Forbidden" says nothing about the message: Kick's bare 403 stays per-channel (contract 10).
  assert.equal(refusalByClass(403, { data: {}, message: "Forbidden" }), null);
  assert.equal(refusalByClass(429, { message: "Too Many Requests" }), null, "a bare rate limit stays infrastructure");
  assert.equal(refusalByClass(400, { error: "Bad Request", status: 400 }), null);
});

test("401 and 404 keep their own meanings (the viewer's link, the channel offline): not a refusal", () => {
  assert.equal(refusalByClass(401, { message: "Invalid token" }), null);
  assert.equal(refusalByClass(404, { message: "Channel not found" }), null);
});

test("a sentence about the channel's mode or the sender's standing still drives the once-per-session note", () => {
  const follow = refusalByClass(400, { message: "You must follow this channel to chat" });
  assert.deepEqual(follow, { refused: true, reason: FOLLOWERS_ONLY });
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: follow!.reason }), "persistent");
  assert.deepEqual(refusalByClass(403, { message: "You are banned from this chatroom" }), { refused: true, reason: BANNED_THERE });
  // Everything else is the platform's own words, and transient.
  assert.equal(deliveryFailureKind({ platform: "kick", error: "refused", reason: "MAX_SPECIAL_CHARS_ERROR" }), "transient");
});

test("the platform's words are shown as one line, bounded, with no markup", () => {
  assert.equal(refusalByClass(400, { message: "  two\nlines <b>x</b> " })?.reason, "two lines b x /b");
  assert.equal(refusalByClass(400, { message: "x".repeat(200) })?.reason.length, 80);
  assert.equal(refusalByClass(400, ["array"]), null);
});

test("YouTube: quota and rate limits stay infrastructure (#184); any other 4xx sentence is a refusal", () => {
  const quota = JSON.stringify({ error: { code: 403, message: "The request cannot be completed because you have exceeded your quota.", errors: [{ domain: "youtube.quota", reason: "quotaExceeded" }] } });
  assert.deepEqual(youtubeErrorOutcome(403, quota), { error: "unavailable", reason: "quota", code: "youtube.quota" });
  const ended = JSON.stringify({ error: { code: 403, message: "The live chat is no longer live.", errors: [{ reason: "liveChatEnded" }] } });
  assert.deepEqual(youtubeErrorOutcome(403, ended), { error: "refused", reason: "The live chat is no longer live." });
  const scope = JSON.stringify({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } });
  assert.deepEqual(youtubeErrorOutcome(403, scope), { error: "missing_scope" }, "re-linking is the fix, so it keeps its own line");
  assert.deepEqual(youtubeErrorOutcome(503, JSON.stringify({ error: { code: 503, message: "Backend Error" } })),
    { error: "unavailable", reason: "upstream", code: "youtube.http_503" });
  assert.deepEqual(youtubeErrorOutcome(400, "not json"), { error: "send_failed" }, "no words → the generic line");
});

test("Kick's 2xx `is_sent: false` reads its words from the same fields", () => {
  assert.deepEqual(kickSendOutcome({ data: { is_sent: false }, message: "MAX_SPECIAL_CHARS_ERROR" }), { sent: false, reason: "MAX_SPECIAL_CHARS_ERROR" });
  assert.deepEqual(kickSendOutcome({ message: "Chatroom is in followers only mode", data: { is_sent: false } }), { sent: false, reason: FOLLOWERS_ONLY });
});

test("wiring: every sender asks the class rule before the status, and the old sentence list is gone", () => {
  const chat = stripComments(readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8"));
  const twitchRefusal = chat.indexOf("const refusal = refusalByClass(res.status, parseJson(text));");
  const twitchDown = chat.indexOf('const down = httpUnavailable("twitch", res.status);');
  assert.ok(twitchRefusal > 0 && twitchDown > twitchRefusal, "Twitch: the class rule first, then the status");
  const kickRefusal = chat.indexOf("const refusal = refusalByClass(res.status, body);");
  const kickDown = chat.indexOf('const down = httpUnavailable("kick", res.status);');
  const kickForbidden = chat.indexOf("kickForbiddenOutcome(await kickFollowersOnly(");
  assert.ok(kickRefusal > 0 && kickDown > kickRefusal && kickForbidden > kickDown, "Kick: class rule → infrastructure → the per-channel bare 403");
  assert.doesNotMatch(chat, /kickKnownRefusal|kickErrorOutcome/, "the known-sentence list is retired");
  const delivery = stripComments(readFileSync(new URL("./sendDelivery.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(delivery, /KICK_PATTERNS/, "the known-sentence list is retired");
  // END anchors: both files were read to their last line.
  assert.match(chat.trimEnd(), /\n\}$/);
  assert.match(delivery.trimEnd(), /\n\}$/);
});

// ── The whole path: the platform's answer → the route's failure → the composer's note ──
// The original send, a retry of the same message, and a restarted page (a fresh store).

const { mountHook } = await import("./testDom.ts");
await import("./testTsx.ts");
const { failureOf } = await import("./sendDelivery.ts");

async function storeView(store: typeof import("./platformRefusals.ts")) {
  return mountHook(() => ({ note: store.useRefusalNote() }));
}

/** Read through a function: an `assert.equal(note, null)` would otherwise narrow it to null for good. */
function noteOf(v: { current: { note: { text: string; id: number } | null } }) {
  return v.current.note;
}

/** What the Kick sender returns for this answer, as the route reports it. */
function kickFailure(status: number, body: unknown) {
  const refusal = refusalByClass(status, body);
  return failureOf("kick", refusal ? { error: "refused", reason: refusal.reason } : { error: "send_failed" });
}

test("original path: Kick's MAX_SPECIAL_CHARS_ERROR shows in the composer in Kick's words", async () => {
  const store = await import("./platformRefusals.ts");
  store.resetRefusals();
  const v = await storeView(store);
  let marked: string[] = [];
  await v.act(() => { marked = store.recordFailures([kickFailure(400, SPECIAL)], 1_000).marked; });
  assert.equal(v.current.note?.text, "Posted here — Kick refused it (MAX_SPECIAL_CHARS_ERROR).");
  assert.deepEqual(marked, ["kick"], "the line carries the marker too");
  // The infrastructure case on the same path says nothing.
  store.resetRefusals();
  await v.act(() => { store.recordFailures([failureOf("kick", { error: "unavailable", reason: "upstream" })], 2_000); });
  assert.equal(v.current.note, null, "a 5xx is silent to the sender");
});

test("retry: the same refusal again inside the window is quiet, and shown again after it", async () => {
  const store = await import("./platformRefusals.ts");
  store.resetRefusals();
  const v = await storeView(store);
  await v.act(() => { store.recordFailures([kickFailure(400, SPECIAL)], 10_000); });
  const first = v.current.note?.id;
  await v.act(() => { store.dismissRefusalNote(); });
  await v.act(() => { store.recordFailures([kickFailure(400, SPECIAL)], 10_000 + 1_000); });
  assert.equal(noteOf(v), null, "one note per window, never one per message");
  await v.act(() => { store.recordFailures([kickFailure(400, SPECIAL)], 10_000 + store.TRANSIENT_WINDOW_MS); });
  assert.equal(noteOf(v)?.text, "Posted here — Kick refused it (MAX_SPECIAL_CHARS_ERROR).");
  assert.notEqual(noteOf(v)?.id, first);
});

test("restart: a fresh page (a new store) explains the refusal again on its first send", async () => {
  const before = await import("./platformRefusals.ts");
  before.resetRefusals();
  before.recordFailures([kickFailure(400, SPECIAL)], 1_000);
  const fresh = await import(`./platformRefusals.ts?restart=${Date.now()}`) as typeof import("./platformRefusals.ts");
  const v = await storeView(fresh);
  await v.act(() => { fresh.recordFailures([kickFailure(400, SPECIAL)], 1_500); });
  assert.equal(v.current.note?.text, "Posted here — Kick refused it (MAX_SPECIAL_CHARS_ERROR).");
});
