// The owner's record of platform copies that did not land: one journal line per
// failure — ids, platform, class and the provider's code, never the message or
// who sent it — and a quota-out night does not print 400 identical lines.
//
// Run: node --test app/lib/copyFailureLog.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { copyFailureLogger, COPY_LOG_WINDOW_MS } from "./copyFailureLog.ts";
import { twitchDropCode } from "./sendDelivery.ts";
import { stripComments } from "./testSource.ts";

function harness() {
  const lines: string[] = [];
  let now = 1_000_000;
  const log = copyFailureLogger((l) => lines.push(l), () => now);
  return { lines, log, advance: (ms: number) => { now += ms; } };
}

const quota = { error: "unavailable", reason: "quota", code: "youtube.quota" };

test("the line's shape: platform, class, cause, provider code, the site line's id — nothing else", () => {
  const h = harness();
  h.log("youtube", quota, 4242);
  assert.deepEqual(h.lines, [
    "[chat/send] copy not delivered platform=youtube class=infrastructure error=unavailable reason=quota code=youtube.quota msg=4242",
  ]);
});

test("the other classes log their class; a transient refusal's free-text reason is left out", () => {
  const h = harness();
  h.log("kick", { error: "refused", reason: "followers-only" }, 1);
  h.log("twitch", { error: "refused", reason: "Some sentence a platform wrote about casey" }, 2);
  h.log("twitch", { error: "not_live" });
  assert.deepEqual(h.lines, [
    "[chat/send] copy not delivered platform=kick class=persistent error=refused reason=followers-only code=refused msg=1",
    "[chat/send] copy not delivered platform=twitch class=transient error=refused code=refused msg=2",
    "[chat/send] copy not delivered platform=twitch class=transient error=not_live code=not_live",
  ]);
  assert.doesNotMatch(h.lines.join("\n"), /casey/, "a platform's own sentence can name people — never logged");
});

test("a Twitch drop is logged with Twitch's drop code, always, and never its message text (P03)", () => {
  // The defect: one viewer's every Twitch copy was dropped (0/178) and the line said only
  // class=transient error=refused — no cause. The drop CODE names the cause and never a person.
  const h = harness();
  h.log("twitch", { error: "refused", reason: "held by AutoMod", dropCode: "msg_rejected" }, 1);
  h.log("twitch", { error: "refused", reason: "Your message about casey was not sent", dropCode: "unknown" }, 2);
  h.log("twitch", { error: "refused", reason: "followers-only", dropCode: "msg_followersonly" }, 3);
  assert.deepEqual(h.lines, [
    "[chat/send] copy not delivered platform=twitch class=transient error=refused drop=msg_rejected code=refused msg=1",
    "[chat/send] copy not delivered platform=twitch class=transient error=refused drop=unknown code=refused msg=2",
    "[chat/send] copy not delivered platform=twitch class=persistent error=refused reason=followers-only drop=msg_followersonly code=refused msg=3",
  ], "an undocumented code is drop=unknown; two different codes are two lines, not one suppressed");
  assert.doesNotMatch(h.lines.join("\n"), /casey|message about/, "Twitch's own sentence never reaches the log");
});

test("RESTART: a fresh logger (a restarted process) logs the first drop with its code", () => {
  const first = harness();
  first.log("twitch", { error: "refused", reason: "slow mode", dropCode: "msg_slowmode" }, 1);
  const restarted = harness();
  restarted.log("twitch", { error: "refused", reason: "slow mode", dropCode: "msg_slowmode" }, 1);
  assert.deepEqual(restarted.lines, first.lines);
  assert.match(restarted.lines[0]!, / drop=msg_slowmode /);
});

test("only a documented Twitch drop code is logged as itself; any other value is 'unknown'", () => {
  const body = (drop_reason: unknown) => ({ data: [{ is_sent: false, drop_reason }] });
  assert.equal(twitchDropCode(body({ code: "msg_rejected", message: "about casey" })), "msg_rejected");
  for (const code of ["msg_banned", "msg_timedout", "msg_duplicate", "msg_ratelimit", "msg_requires_verified_phone_number", "msg_verified_email", "automod_held"]) {
    assert.equal(twitchDropCode(body({ code })), code);
  }
  assert.equal(twitchDropCode(body({ code: "msg_brand_new_code" })), "unknown", "undocumented, even shaped like a code");
  assert.equal(twitchDropCode(body({ code: "casey" })), "unknown", "a single word could be a name");
  assert.equal(twitchDropCode(body({ code: "a sentence about casey" })), "unknown");
  assert.equal(twitchDropCode(body({ code: 42 })), "unknown");
  assert.equal(twitchDropCode(body({ message: "no code" })), undefined);
  assert.equal(twitchDropCode({ data: [{ is_sent: true, message_id: "x" }] }), undefined);
  assert.equal(twitchDropCode(null), undefined);
});

test("the Twitch sender hands the drop code to the route with the refusal", () => {
  const chat = stripComments(readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8"));
  assert.match(chat, /const dropCode = twitchDropCode\(body\);/);
  assert.match(chat, /if \(!outcome\.sent\) return \{ ok: false, error: "refused", \.\.\.\(outcome\.reason \? \{ reason: outcome\.reason \} : \{\}\), \.\.\.\(dropCode \? \{ dropCode \} : \{\}\) \};/);
});

test("rate limit: a quota-out night is one line per platform per 10 minutes, the next one carrying the count", () => {
  const h = harness();
  for (let i = 0; i < 400; i++) { h.log("youtube", quota, 5000 + i); h.advance(1_000); } // 400 sends over 6m40s
  assert.equal(h.lines.length, 1, "400 identical failures inside the window: one line");
  h.advance(COPY_LOG_WINDOW_MS);
  h.log("youtube", quota, 9999);
  assert.equal(h.lines.length, 2);
  assert.match(h.lines[1]!, / msg=9999 suppressed=399$/, "the next line says how many were not printed");
  // A different platform, or a different code on the same one, is its own line.
  h.log("twitch", { error: "unavailable", reason: "upstream", code: "twitch.http_503" }, 1);
  h.log("youtube", { error: "unavailable", reason: "rate_limited", code: "youtube.http_429" }, 2);
  assert.equal(h.lines.length, 4);
});

test("RETRY: the same send retried logs nothing new inside the window", () => {
  const h = harness();
  h.log("youtube", quota, 7);
  h.log("youtube", quota, 7);
  assert.equal(h.lines.length, 1);
});

test("the send route logs every failed copy through it, and never the sender", () => {
  const route = stripComments(readFileSync(new URL("../api/chat/send/route.ts", import.meta.url), "utf8"));
  assert.match(route, /import \{ logCopyFailure \} from "@\/app\/lib\/copyFailureLog";/);
  // Fan-out and single target.
  assert.match(route, /if \(!x\.r\.ok\) logCopyFailure\(x\.p, x\.r, siteMsgId\);/);
  assert.match(route, /if \(!result\.ok\) logCopyFailure\(platformTarget, result, singleSiteMsgId\);/);
  // A throw is classified (a timeout is infrastructure), not a bare send_failed.
  assert.equal((route.match(/\.catch\(\(err\): PlatformSendResult => \{\s*const f = thrownFailure\(err\);/g) ?? []).length, 2);
  assert.equal((route.match(/return \{ ok: false, \.\.\.f \};/g) ?? []).length, 2);
  // No journal line in the send path names the sender's matrix id.
  for (const m of route.matchAll(/console\.(?:log|info|warn|error)\(([^;]*)\);/g)) {
    assert.doesNotMatch(m[1]!, /matrixId/, m[0]);
  }
  // END anchor (the loop above is negative — it must have read the whole file).
  assert.match(route.trimEnd(), /  return new Response\("OK"\);\n\}$/);
});
