// Which platforms a ban reached: the rows a fan-out writes, read back into one line, the ✗ on
// history and Bans rows, and a Retry that re-runs the failures.
// Run: node --test app/lib/modPropagation.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { outcomesOf, propagationLine, failedPlatforms, failedByBatch, awaitPropagation, retryFailed, type ActionRow } from "./modPropagation.ts";
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
  assert.match(ban, /const platforms = fanOutBan\(a\.mod, targetId, a\.durationMinutes, a\.reason, a\.batchId\);\s*return \{ applied: true, previous, platforms \};/);
  assert.match(ban, /const action: BanAction = \{ mod, durationMinutes, expiresAt, reason, override: body\.override === true, batchId \};/);
  assert.match(ban, /return Response\.json\(\{ ok: true, applied: true, expiresAt, previous: first\.previous, batchId, platforms, accounts: targets\.length \}\);/);
  assert.match(ban, /for \(const p of fanOutUnban\(mod, t, batchId\)\) platforms\.add\(p\);\s*\}\s*await pushChatBan\(chatBanBody\(\{ matrixIds: targets, canonicalId, expiresAt: null, lift: true \}\)\);\s*return Response\.json\(\{ ok: true, batchId, platforms: \[\.\.\.platforms\] \}\);\s*\}\s*$/, "vacuity anchor: the unban's end");
  const retry = read("../api/mod/platform-actions/retry/route.ts");
  for (const call of ["banOnTwitch(mod, row.target_id, dur, null, row.batch_id)", "banOnKick(mod, row.target_id, dur, null, row.batch_id)",
    "banOnYouTube(mod, row.target_id, dur, row.batch_id)", "unbanOnTwitch(mod, row.target_id, row.batch_id)",
    "unbanOnKick(mod, row.target_id, row.batch_id)", "unbanOnYouTube(mod, row.target_id, row.batch_id)"]) {
    assert.ok(retry.includes(call), call);
  }
  const fan = read("./platformMod/index.ts");
  assert.match(fan, /ok: false, detail: "unsupported", batchId \}\);/);
});
