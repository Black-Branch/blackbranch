// The send hook's handling of every delivery outcome, RUN against stubbed route
// answers — the shapes the send route returns (route.ts, `failed` / `posted` /
// `id` / `pollVote`), plus a source check that the route builds them.
//
// A line that went up on the site and was refused
// by a platform is never "message not sent" and is never an error per message.
// A PERSISTENT refusal (followers-only, banned there…) is explained ONCE in the
// composer's note and the platform is skipped for the session; a TRANSIENT
// failure is noted at most once per platform per window. The three acceptance
// tests are marked ACCEPTANCE below.
//
// Run: node --test app/lib/sendDeliveryHook.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mountHook } from "./testDom.ts";
import { stripComments } from "./testSource.ts";

await import("./testTsx.ts");
const { useSendChatMessage } = await import("./useSendChatMessage.ts");
const { onChatNotice } = await import("./chatNotice.ts");
const { useUndelivered } = await import("./undeliveredLines.ts");
const { useRefusalNote, retryDestination, resetRefusals, dismissRefusalNote, TRANSIENT_WINDOW_MS } = await import("./platformRefusals.ts");

// Not a React hook despite the name — it builds a plain async sender. Called inside each test.
function useSend() { return useSendChatMessage(() => {}); }
const realFetch = globalThis.fetch;
type Sent = { forced_destination?: string; skip_platforms?: string[]; message?: string };
let sent: Sent[] = [];
function answer(body: unknown, status = 200) {
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? "{}"));
    return Response.json(body, { status });
  }) as typeof fetch;
}
test.beforeEach(() => { resetRefusals(); sent = []; });
test.afterEach(() => { globalThis.fetch = realFetch; });

async function thrown(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("expected the send to throw");
}

/** What the composer and the chat list see: the note, and the marks on lines `ids`. */
async function view(ids: number[] = []) {
  return mountHook(() => ({ note: useRefusalNote(), marks: ids.map((id) => useUndelivered(id)) }));
}

/**
 * The send route as far as Kick's followers-only chat is concerned: the site line
 * always goes up first; Kick, when it is asked (named as the destination, or in
 * the fan-out, and not in `skip_platforms`), refuses. Mirrors route.ts's answers.
 */
function followersOnlyKick(linked: string[] = ["kick"], firstId = 1) {
  let id = firstId - 1;
  const kickAsked: number[] = [];
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as Sent;
    sent.push(b);
    id++;
    const skip = new Set(b.skip_platforms ?? []);
    const refusal = { platform: "kick", error: "refused", reason: "followers-only" };
    if (b.forced_destination === "kick" && !skip.has("kick")) {
      kickAsked.push(id);
      return Response.json({ error: "refused", platform: "kick", reason: "followers-only", posted: true, id, failed: [refusal] }, { status: 409 });
    }
    if (b.forced_destination === "all") {
      const targets = linked.filter((p) => !skip.has(p));
      if (targets.length > 0) {
        if (targets.includes("kick")) kickAsked.push(id);
        const ok = targets.filter((p) => p !== "kick");
        const failed = targets.includes("kick") ? [refusal] : [];
        return ok.length > 0
          ? Response.json({ sentTo: "all", platforms: ok, posted: true, id, failed })
          : Response.json({ error: "send_failed", platform: "all", posted: true, id, failed }, { status: 409 });
      }
    }
    return new Response("OK"); // the site line alone
  }) as typeof fetch;
  return kickAsked;
}

// ── ACCEPTANCE ───────────────────────────────────────────────────────────────

test("ACCEPTANCE: 20 sends to a followers-only Kick produce exactly one note and zero extra rows", async () => {
  const kickAsked = followersOnlyKick();
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  const v = await view(ids);
  const notes = new Set<number>();
  for (let i = 0; i < 20; i++) {
    // No send throws: the line is up every time, so there is no per-message error.
    await v.act(async () => { await useSend()(`hi ${i}`, null, "kick"); });
    if (v.current.note) notes.add(v.current.note.id);
  }
  assert.equal(notes.size, 1, "exactly one note in 20 sends");
  assert.equal(v.current.note?.text, "Kick is followers-only. Follow on Kick to post there, or change Send to.");
  assert.equal(v.current.marks.filter((m) => m != null).length, 0, "no line gets an extra row (or any mark)");
  assert.deepEqual(kickAsked, [1], "Kick is asked once; the other 19 sends never make a refused call");
  assert.equal(sent.length, 20, "every line still posts on the site");
  assert.ok(sent.slice(1).every((b) => b.skip_platforms?.includes("kick")), "each later send leaves Kick out before it leaves the browser");
  await v.unmount();
});

test("ACCEPTANCE: re-selecting Kick in Send to retries it", async () => {
  const kickAsked = followersOnlyKick();
  const v = await view();
  for (let i = 0; i < 3; i++) await v.act(async () => { await useSend()("hi", null, "kick"); });
  assert.deepEqual(kickAsked, [1]);
  // What SendToButton's pick (or re-pick of the current entry) runs — ChatInput wires it.
  await v.act(() => retryDestination("kick"));
  await v.act(async () => { await useSend()("followed now?", null, "kick"); });
  assert.deepEqual(kickAsked, [1, 4], "the re-selected platform is asked again");
  assert.equal(sent[3]?.skip_platforms, undefined, "nothing skipped on the retry");
  await v.act(async () => { await useSend()("and again", null, "kick"); });
  assert.deepEqual(kickAsked, [1, 4], "still refusing → skipped again, no repeated calls");
  await v.unmount();
});

test("ACCEPTANCE: a transient failure shows at most once per window", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let id = 300;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    sent.push(JSON.parse(init?.body ?? "{}"));
    id++;
    return Response.json({ error: "not_live", platform: "twitch", posted: true, id, failed: [{ platform: "twitch", error: "not_live" }] }, { status: 409 });
  }) as typeof fetch;
  const v = await view(Array.from({ length: 11 }, (_, i) => 301 + i));
  const notes = new Set<number>();
  for (let i = 0; i < 10; i++) {
    await v.act(async () => { await useSend()("hi", null, "twitch"); });
    if (v.current.note) notes.add(v.current.note.id);
    t.mock.timers.tick(10_000);
  }
  assert.equal(notes.size, 1, "ten failures inside the window: one note");
  assert.equal(v.current.note?.text, "Posted here — Twitch isn't live.");
  assert.deepEqual(sent.map((b) => b.skip_platforms), Array(10).fill(undefined), "a transient failure is never skipped — every send tries");
  assert.equal(v.current.marks.slice(0, 10).filter((m) => m?.[0] === "twitch").length, 10,
    "each line that missed Twitch carries the zero-height marker");
  t.mock.timers.tick(TRANSIENT_WINDOW_MS);
  await v.act(async () => { await useSend()("hi", null, "twitch"); });
  if (v.current.note) notes.add(v.current.note.id);
  assert.equal(notes.size, 2, "after the window it may show again");
  await v.unmount();
});

// ── Infrastructure: YouTube's quota is out ───────────────────────────────────

/**
 * The send route on a quota-out night: the site line goes up, YouTube answers
 * 403 youtube.quota (the route reports `unavailable`/`quota`), Kick may refuse
 * followers-only, every other linked platform takes it. Mirrors route.ts.
 */
function quotaOutYouTube(linked: string[], firstId: number, kickFollowersOnly = false) {
  let id = firstId - 1;
  globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => {
    const b = JSON.parse(init?.body ?? "{}") as Sent;
    sent.push(b);
    id++;
    const skip = new Set(b.skip_platforms ?? []);
    const fail = (p: string) =>
      p === "youtube" ? { platform: "youtube", error: "unavailable", reason: "quota" }
        : p === "kick" && kickFollowersOnly ? { platform: "kick", error: "refused", reason: "followers-only" }
          : null;
    if (b.forced_destination === "all") {
      const targets = linked.filter((p) => !skip.has(p));
      const failed = targets.flatMap((p) => { const f = fail(p); return f ? [f] : []; });
      const ok = targets.filter((p) => !fail(p));
      return ok.length > 0
        ? Response.json({ sentTo: "all", platforms: ok, posted: true, id, failed })
        : Response.json({ error: "send_failed", platform: "all", posted: true, id, failed }, { status: 409 });
    }
    const p = b.forced_destination;
    const f = p && !skip.has(p) ? fail(p) : null;
    if (f) return Response.json({ error: f.error, platform: p, reason: f.reason, posted: true, id, failed: [f] }, { status: 409 });
    return Response.json({ sentTo: p ?? null, id });
  }) as typeof fetch;
}

test("ACCEPTANCE (a): quota-out with All selected — no marker, no note, no row, no error; Twitch unchanged", async () => {
  quotaOutYouTube(["twitch", "youtube"], 701);
  const ids = Array.from({ length: 10 }, (_, i) => 701 + i);
  const v = await view(ids);
  for (let i = 0; i < 10; i++) {
    await v.act(async () => { assert.equal(await useSend()(`hi ${i}`, null, "all"), "all", "no throw → no composer error"); });
  }
  assert.equal(v.current.note, null, "nothing in the composer");
  assert.deepEqual(v.current.marks, Array(10).fill(null), "no ⊘ on any line");
  assert.ok(sent.every((b) => b.skip_platforms === undefined), "YouTube is never skipped — every copy is tried");
  await v.unmount();
});

test("ACCEPTANCE (a): quota-out with All and YouTube the only linked platform (409, posted) — still silent", async () => {
  quotaOutYouTube(["youtube"], 721);
  const v = await view([721, 722]);
  for (let i = 0; i < 2; i++) await v.act(async () => { assert.equal(await useSend()("hi", null, "all"), null); });
  assert.equal(v.current.note, null);
  assert.deepEqual(v.current.marks, [null, null]);
  await v.unmount();
});

test("ACCEPTANCE (b): quota-out with YouTube alone — the one plain line, once; a second send shows nothing new", async () => {
  quotaOutYouTube(["twitch", "youtube"], 741);
  const v = await view([741, 742, 743]);
  await v.act(async () => { assert.equal(await useSend()("hi", null, "youtube"), null, "no throw: the line is up here"); });
  const first = v.current.note;
  assert.equal(first?.text, "Couldn't reach YouTube chat right now.");
  assert.equal(first?.forms.some((f) => /quota|403|limit/i.test(f)), false, "no error code, no mention of quotas");
  await v.act(() => dismissRefusalNote(first?.id));
  await v.act(async () => { await useSend()("hi again", null, "youtube"); });
  await v.act(async () => { await useSend()("and again", null, "youtube"); });
  assert.equal(v.current.note, null, "the session has had its line");
  assert.deepEqual(v.current.marks, [null, null, null], "no ⊘ on the line, ever");
  assert.ok(sent.every((b) => b.skip_platforms === undefined), "not skipped: re-sending to YouTube is allowed");
  await v.unmount();
});

test("ACCEPTANCE (b): a reply that the toggle would send to YouTube is implicit — silent", async () => {
  quotaOutYouTube(["youtube"], 761);
  const v = await view([761]);
  // The route ignores the toggle for a reply (it routes to the replied-to person's platform).
  await v.act(async () => { await useSend()("hi", { id: 1, platform: "youtube", username: "casey", message: "x" } as never, "youtube"); });
  assert.equal(v.current.note, null);
  await v.unmount();
});

test("ACCEPTANCE (c): Kick followers-only is still explained, in the same fan-out as YouTube's quota-out", async () => {
  quotaOutYouTube(["twitch", "kick", "youtube"], 781, true);
  const v = await view([781, 782]);
  await v.act(async () => { await useSend()("hi", null, "all"); });
  assert.equal(v.current.note?.text, "Kick is followers-only. Follow on Kick to post there, or change Send to.");
  await v.act(async () => { await useSend()("hi", null, "all"); });
  assert.deepEqual(sent[1]?.skip_platforms, ["kick"], "Kick skipped from then on, YouTube not");
  assert.deepEqual(v.current.marks, [null, null]);
  await v.unmount();
});

test("RETRY: re-sending the same message to YouTube alone after the line does not duplicate it", async () => {
  quotaOutYouTube(["youtube"], 801);
  const v = await view([801, 802]);
  await v.act(async () => { await useSend()("same words", null, "youtube"); });
  const first = v.current.note!;
  await v.act(async () => { await useSend()("same words", null, "youtube"); });
  assert.equal(v.current.note?.id, first.id, "still the one line — not a second, not a replacement");
  assert.equal(sent.length, 2, "the retry itself went out (the platform is not skipped)");
  await v.unmount();
});

// ── The other outcomes ───────────────────────────────────────────────────────

test("send to all, Kick refused followers-only (200): the note, Kick left out next time, Twitch still sent", async () => {
  const kickAsked = followersOnlyKick(["twitch", "kick"], 501);
  const v = await view([501, 502]);
  assert.equal(await useSend()("hi", null, "all"), "all");
  assert.equal(await useSend()("hi", null, "all"), "all");
  await v.act(async () => {});
  assert.deepEqual(kickAsked, [501]);
  assert.deepEqual(sent[1]?.skip_platforms, ["kick"]);
  assert.equal(v.current.note?.platform, "kick");
  assert.deepEqual(v.current.marks, [null, null]);
  await v.unmount();
});

test("send to all, every platform failed (409, posted): never 'not sent'; transient ones noted together and marked", async () => {
  answer({ error: "send_failed", platform: "all", posted: true, id: 9003,
    failed: [{ platform: "kick", error: "refused" }, { platform: "twitch", error: "not_live" }] }, 409);
  const v = await view([9003]);
  await v.act(async () => { assert.equal(await useSend()("hi", null, "all"), null); });
  assert.equal(v.current.note?.text, "Posted here — Kick refused it; Twitch isn't live.");
  assert.deepEqual(v.current.marks[0], ["kick", "twitch"]);
  await v.unmount();
});

test("a reply that reached only the site says so (once), and is marked", async () => {
  answer({ ok: true, posted: true, id: 9004, failed: [{ platform: "twitch", error: "send_failed" }] });
  const v = await view([9004]);
  await v.act(async () => { await useSend()("hi", { id: 1, platform: "twitch", username: "casey", message: "x" } as never); });
  assert.equal(v.current.note?.text, "Posted here — couldn't reach Twitch.");
  assert.deepEqual(v.current.marks[0], ["twitch"]);
  await v.unmount();
});

test("a command aimed at a platform: posted here, not there — a note, no draft restore", async () => {
  answer({ error: "command_native_only", platform: "twitch", posted: true, id: 9005,
    failed: [{ platform: "twitch", error: "command_native_only" }] }, 409);
  const v = await view();
  await v.act(async () => { assert.equal(await useSend()("!so casey", null, "twitch"), null); });
  assert.equal(v.current.note?.text, "Posted here — commands aren't sent to Twitch.");
  await v.unmount();
});

test("a 409 for a line that was NEVER posted keeps 'message not sent' (an ordinary error — the draft comes back)", async () => {
  answer({ error: "not_featured_platform", platform: "kick", featured: "casey" }, 409);
  const err = await thrown(useSend()("hi", null, "kick"));
  assert.match(err.message, /message not sent/);
});

test("a redacted send carries no skip list (it never leaves the site)", async () => {
  followersOnlyKick();
  await useSend()("hi", null, "kick");
  answer({ ok: true, id: 1 });
  await useSend()("secret", null, null, null, true);
  assert.equal(sent.at(-1)!.skip_platforms, undefined);
});

test("a clean send stays silent and returns where it went", async () => {
  answer({ sentTo: "twitch", id: 9006 });
  assert.equal(await useSend()("hi", null, "twitch"), "twitch");
});

test("a poll vote: 'Counted as a vote', non-blocking, nothing thrown", async () => {
  const seen: string[] = [];
  const off = onChatNotice((t) => seen.push(t));
  try {
    answer({ ok: true, pollVote: { optionN: 2 } });
    assert.equal(await useSend()("2", null), null);
    assert.equal(seen.at(-1), "Counted as a vote for option 2");
  } finally { off(); }
});

test("a vote stream-api could not store says so", async () => {
  answer({ error: "vote_failed" }, 503);
  const err = await thrown(useSend()("2", null));
  assert.equal(err.message, "Your vote wasn't counted — try again.");
});

// ── The route's half ─────────────────────────────────────────────────────────

test("the route builds the report on every path that posts before the platform answers", () => {
  const route = stripComments(readFileSync(new URL("../api/chat/send/route.ts", import.meta.url), "utf8"));
  // Fan-out: every platform that did not take it is in `failed`.
  assert.match(route, /const failed = results\.flatMap\(\(x\) => \(x\.r\.ok \? \[\] : \[failureOf\(x\.p, x\.r\)\]\)\);/);
  assert.match(route, /return Response\.json\(\{ sentTo: "all", platforms: sent, \.\.\.report \}\);/);
  assert.match(route, /\{ error: "send_failed", platform: "all", \.\.\.report \}, \{ status: 409 \}/);
  // Single target: posted + failed on the explicit 409 and on the reply fallback.
  assert.match(route, /const singleReport = \{ posted: singlePosted, failed: \[failureOf\(platformTarget, result\)\], \.\.\.singleNative \};/);
  assert.match(route, /return Response\.json\(\{ ok: true, \.\.\.singleReport \}\);/);
  // The poll vote is forwarded, and a failed vote is not a generic 502.
  assert.match(route, /if \(plain\.pollVote\) return Response\.json\(\{ ok: true, pollVote: plain\.pollVote \}\);/);
  assert.match(route, /if \(err\?\.error === "vote_failed"\) return Response\.json\(\{ error: "vote_failed" \}, \{ status: 503 \}\);/);
  // END anchor: the handler still closes on its last line.
  assert.match(route.trimEnd(), /  return new Response\("OK"\);\n\}$/);
});

test("the route honours skip_platforms on all three outbound paths — and only ever removes the sender's own", () => {
  const route = stripComments(readFileSync(new URL("../api/chat/send/route.ts", import.meta.url), "utf8"));
  assert.match(route, /const skipPlatforms = skipPlatformsFrom\(body\);/, "parsed by the one validated helper");
  // Fan-out: the linked set minus the skips; an all-skipped fan-out posts the site line alone.
  assert.match(route, /const targets = linkedTargets\.filter\(\(p\) => !skipPlatforms\.has\(p\)\);/);
  assert.match(route, /if \(linkedTargets\.length === 0\) \{\s*return Response\.json\(\{ error: "not_linked", platform: "all" \}, \{ status: 403 \}\);\s*\}/);
  assert.match(route, /if \(targets\.length > 0\) \{/);
  // A reply to a skipped platform stays on the site, like a reply to an unlinked one.
  assert.match(route, /\(isReplyRoutable && replyLinked && !skipPlatforms\.has\(reply_to_platform!?\) \? reply_to_platform : null\)/);
  // A skipped forced destination is the site line alone, never a 409 per message.
  assert.match(route, /const forcedSingle = forced_destination && forced_destination !== "all" && !skipPlatforms\.has\(forced_destination\) \? forced_destination : null;/);
  // END anchor.
  assert.match(route.trimEnd(), /  return new Response\("OK"\);\n\}$/);
});

test("the platform senders treat is_sent:false as a refusal", () => {
  const chat = stripComments(readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8"));
  assert.equal((chat.match(/if \(!outcome\.sent\) return \{ ok: false, error: "refused"/g) ?? []).length, 2,
    "both Twitch and Kick map a dropped message to `refused`");
  assert.match(chat, /const err = kickErrorOutcome\(res\.status, body\);/);
  // END anchor.
  assert.match(chat.trimEnd(), /\n\}$/);
});
