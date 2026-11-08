// Which platforms a ban reached: the rows a fan-out writes, read back into one line, the ✗ on
// history and Bans rows, and a Retry that re-runs the failures.
// Run: node --test app/lib/modPropagation.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outcomesOf, propagationLine, removalLine, failedPlatforms, failedByBatch, awaitPropagation, retryFailed, type ActionRow } from "./modPropagation.ts";
import { stripComments } from "./testSource.ts";

const row = (id: number, platform: string, ok: boolean, detail: string | null = null, status: number | null = null, action = "ban"): ActionRow =>
  ({ id, platform, action, ok, status, detail });

const BATCH = [
  row(1, "twitch", true),
  row(2, "kick", false, "no_capable_token"),
  row(3, "youtube", false, "target_no_youtube_id"),
  row(4, "streamplace", false, "unsupported"),
];

test("one line: ✓ landed, ✗ failed with why, – not there; no moderation API is left out", () => {
  assert.equal(propagationLine(outcomesOf(BATCH)), "Twitch ✓ · Kick ✗ (missing scope) · YouTube – (not on YouTube)");
});

test("a platform this install has not set up is left out; an HTTP refusal says its code", () => {
  const line = propagationLine(outcomesOf([row(1, "twitch", false, "twitch_broadcaster_unset"), row(2, "kick", false, "Forbidden", 403)]));
  assert.equal(line, "Kick ✗ (refused, 403)");
});

test("a retry joins the batch: the newest row per platform is the answer", () => {
  const after = [...BATCH, row(9, "kick", true)];
  assert.equal(propagationLine(outcomesOf(after)), "Twitch ✓ · Kick ✓ · YouTube – (not on YouTube)");
  assert.deepEqual(failedPlatforms(after), []);
  assert.deepEqual(failedPlatforms(BATCH), ["kick"], "only a failure is a ✗ — not a skip, not a missing API");
});

test("only a ban, timeout or unban is offered a Retry", () => {
  assert.equal(outcomesOf([row(1, "kick", false, "x", 500, "ban")])[0]!.retryable, true);
  assert.equal(outcomesOf([row(1, "kick", false, "x", 500, "purge")])[0]!.retryable, false);
});

test("failedByBatch: the ✗ list per batch, read in one query", async () => {
  const seen: unknown[][] = [];
  const q = async (_sql: string, params: unknown[]) => {
    seen.push(params);
    return { rows: [
      { id: 1, batch_id: "a", platform: "twitch", action: "ban", ok: true, status: null, detail: null },
      { id: 2, batch_id: "a", platform: "kick", action: "ban", ok: false, status: 500, detail: "x" },
      { id: 3, batch_id: "b", platform: "kick", action: "ban", ok: true, status: null, detail: null },
    ] };
  };
  const m = await failedByBatch(q, ["a", "b", "a", ""]);
  assert.deepEqual([...m], [["a", ["kick"]]]);
  assert.deepEqual(seen, [[["a", "b"]]]);
  assert.equal((await failedByBatch(q, [])).size, 0);
});

// A ban's purge (ticket #228) writes its rows into the ban's batch: the ban's answer per platform
// stays the ban's, and the removal reads as its own part of the line.
const BAN_AND_PURGE = [
  row(1, "twitch", true),
  row(2, "kick", true),
  row(3, "youtube", true, null, 200),
  row(4, "kick", true, "deleted 2/2", null, "purge"),
  row(5, "youtube", true, "no_api_message_ids (3 innertube-only)", null, "purge"),
];

test("a ban's purge rows never stand in for the ban's own answer", () => {
  assert.equal(propagationLine(outcomesOf(BAN_AND_PURGE)), "Twitch ✓ · Kick ✓ · YouTube ✓");
  const failedPurge = [...BAN_AND_PURGE, row(6, "kick", false, "no_capable_token", null, "purge")];
  assert.deepEqual(failedPlatforms(failedPurge), [], "a purge that did not reach Kick marked the BAN ✗");
});

test("what was removed: the site's count, Twitch with the ban, Kick by id, and YouTube said plainly", () => {
  assert.equal(removalLine(BAN_AND_PURGE, 5),
    "Messages: 5 removed here · Twitch clears them with the ban · Kick 2 removed · YouTube can't remove their earlier messages from here");
  assert.equal(removalLine([row(1, "twitch", true, null, null, "timeout"), row(2, "youtube", true, "deleted 1/2", 200, "purge"),
    row(3, "kick", true, "no_messages", null, "purge")], 2),
    "Messages: 2 removed here · Twitch clears them with the timeout · YouTube 1 of 2 removed");
  assert.equal(removalLine([row(1, "twitch", false, "no_capable_token"), row(2, "youtube", false, "not_live", null, "purge")], 0),
    "Messages: none to remove here · YouTube not removed (not live)", "a ban that did not land on Twitch clears nothing there");
  assert.equal(removalLine(BAN_AND_PURGE, null), null, "a ban with the switch off says nothing about messages");
  assert.equal(removalLine([], 3, { clickedSkipped: true }), "Messages: 3 removed here · the clicked message could not be removed");
  assert.equal(removalLine([], null, { purgeFailed: true }), "Messages: couldn't be removed. Purge them by hand.",
    "a purge that failed after the ban read as no purge at all");
});

test("with a purge the status line also waits for Kick's and YouTube's removal rows", async () => {
  const urls = stubFetch([BAN_AND_PURGE.slice(0, 3), BAN_AND_PURGE.slice(0, 4), BAN_AND_PURGE]);
  const out = await awaitPropagation({ batchId: "a", platforms: ["twitch", "kick", "youtube"], purged: 5 }, { sleep: async () => {} });
  assert.equal(urls.length, 3, "the line was read before the removal had answered");
  assert.equal(propagationLine(out), "Twitch ✓ · Kick ✓ · YouTube ✓");
});

function stubFetch(answers: ActionRow[][]) {
  const urls: { url: string; body?: unknown }[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const actions = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify({ actions }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return urls;
}

test("the status line waits until every platform the route named has answered", async () => {
  const urls = stubFetch([[BATCH[0]!], [BATCH[0]!, BATCH[1]!], BATCH]);
  const out = await awaitPropagation({ batchId: "a", platforms: ["twitch", "kick", "youtube", "streamplace"] }, { sleep: async () => {} });
  assert.equal(urls.length, 3);
  assert.match(urls[0]!.url, /^\/api\/mod\/platform-actions\?batchId=a&limit=50$/);
  assert.equal(propagationLine(out), "Twitch ✓ · Kick ✗ (missing scope) · YouTube – (not on YouTube)");
});

test("Retry re-runs each retryable failure by its row id", async () => {
  const urls = stubFetch([[]]);
  await retryFailed(outcomesOf(BATCH));
  assert.deepEqual(urls, [{ url: "/api/mod/platform-actions/retry", body: { id: 2 } }]);
});

test("the ban route tags its fan-out with a batch and returns it; a retry keeps the batch", () => {
  const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
  const ban = read("../api/mod/ban/route.ts");
  // Every linked account's fan-out carries the one batch (a ban acts on each account).
  assert.match(ban, /const platforms = fanOutBan\(a\.mod, targetId, a\.durationMinutes, a\.reason, a\.batchId\);\s*return \{ applied: true, previous, platforms, keptIdentities \};/);
  assert.match(ban, /const action: BanAction = \{ mod, durationMinutes, expiresAt, reason, override: body\.override === true, batchId, covered: targets \};/);
  assert.match(ban, /return Response\.json\(\{ ok: true, applied: true, expiresAt, previous: first\.previous, batchId, platforms, accounts: targets\.length, identitiesKeepBan, purged, purgeFailed, clickedSkipped: clicked === "invalid" \}\);/);
  assert.match(ban, /for \(const p of fanOutUnban\(mod, t, batchId\)\) platforms\.add\(p\);\s*\}\s*await pushChatBan\(chatBanBody\(\{ matrixIds: targets, canonicalId, expiresAt: null, lift: true \}\)\);\s*await requestReconcile\(\);\s*return Response\.json\(\{ ok: true, batchId, platforms: \[\.\.\.platforms\] \}\);\s*\}\s*$/, "vacuity anchor: the unban's end");
  const retry = read("../api/mod/platform-actions/retry/route.ts");
  for (const call of ["banOnTwitch(mod, row.target_id, dur, null, row.batch_id)", "banOnKick(mod, row.target_id, dur, null, row.batch_id)",
    "banOnYouTube(mod, row.target_id, dur, row.batch_id)", "unbanOnTwitch(mod, row.target_id, row.batch_id)",
    "unbanOnKick(mod, row.target_id, row.batch_id)", "unbanOnYouTube(mod, row.target_id, row.batch_id)"]) {
    assert.ok(retry.includes(call), call);
  }
  const fan = read("./platformMod/index.ts");
  assert.match(fan, /ok: false, detail: "unsupported", batchId \}\);/);
});
