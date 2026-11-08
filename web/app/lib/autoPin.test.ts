// The crowd auto-pin threshold, and the guards around it.
//
// The threshold scales with active chatters, so a pin at 3 points does not
// come too cheaply on a busy stream.
//
// Pinning costs no points: there is no `pin` row in site.store_prices and no
// /api/points/spend/pin. The threshold is `AUTO_PIN_SCORE`, a NET-UPVOTE
// count — casting a vote *earns* 1 point, which can make it read like a price.
//
// This file covers the threshold, the TTL and tryAutoPin's "never bump a mod's
// pin" rule. Since ticket #189 the streamer sets the numbers (Admin Panel ›
// Site › Auto-pin, the `chat.autoPin.*` instance settings); the product's own
// numbers are the schema defaults, and the curve below is asserted against
// DEFAULT_AUTO_PIN so the measured reasoning still holds for an install that
// never touches them.
//
// Run: node --test app/lib/autoPin.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  autoPinScore, autoPinRulesFrom, autoPinWaitMs, DEFAULT_AUTO_PIN, AUTO_PIN_KEYS, type AutoPinRules,
} from "./votePolicy.ts";
import { createActiveChatters, ACTIVE_CHATTERS_TTL_MS } from "./activeChatters.ts";
import { INSTANCE_KEYS } from "./instanceSchema.generated.mjs";
import { scheduleAutoPinExpiry } from "./autoPinExpiry.ts";

const AUTO_PIN_BASE = DEFAULT_AUTO_PIN.base;
const AUTO_PIN_CHATTERS_PER_STEP = DEFAULT_AUTO_PIN.chattersPerStep;
const AUTO_PIN_MAX = DEFAULT_AUTO_PIN.max;

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => stripComments(readFileSync(join(here, rel), "utf8"));

// ── The curve ───────────────────────────────────────────────────────────────

test("an unknown chatter count falls back to the base, never to zero", () => {
  // null is "the query failed / nothing is live", NOT "nobody is here". Treating
  // it as 0 would still give the base here, but only by luck — assert the
  // contract so a later `?? 0` cannot pass silently.
  assert.equal(autoPinScore(null), AUTO_PIN_BASE);
  assert.equal(autoPinScore(-1), AUTO_PIN_BASE, "a nonsense count must not lower the bar");
});

test("at the measured median crowd the threshold is unchanged", () => {
  // Deliberate: the median busy 15-minute window has 10 distinct chatters,
  // so the common case keeps the base threshold. The scaling raises the bar
  // on busy streams; it is not a different site.
  assert.equal(autoPinScore(10), 3);
  assert.equal(autoPinScore(0), 3);
});

test("it steps by one, and only on a genuinely busier stream", () => {
  // The measured p95 score steps 2 -> 3 -> 3 -> 4 across the whole observed
  // range of crowd sizes. One step is the entire signal in the data.
  assert.equal(autoPinScore(AUTO_PIN_CHATTERS_PER_STEP - 1), 3);
  assert.equal(autoPinScore(AUTO_PIN_CHATTERS_PER_STEP), 4);
  assert.equal(autoPinScore(23), 4, "the busiest window ever measured must still be reachable");
});

test("the threshold can never run away as the site grows", () => {
  // The failure mode that matters is silent: too high a bar does not error,
  // it just means nothing is ever pinned again and nobody knows why. Very few
  // messages over a month ever reach 5.
  assert.equal(autoPinScore(10_000), AUTO_PIN_MAX);
  assert.ok(AUTO_PIN_MAX <= 6, "a ceiling above 6 is past anything ever observed");
});

test("the product's own numbers are today's: 3 upvotes, +1 per 12 chatters, at most 6, 10 minutes, on", () => {
  // The values every install had before ticket #189 made them settings. An install that never
  // opens the card must see no change at all.
  assert.deepEqual({ ...DEFAULT_AUTO_PIN }, { off: false, base: 3, chattersPerStep: 12, max: 6, ttlMs: 600_000 });
});

test("it is monotonic — a bigger crowd never lowers the bar", () => {
  let prev = 0;
  for (let n = 0; n <= 200; n++) {
    const v = autoPinScore(n);
    assert.ok(v >= prev, `threshold fell from ${prev} to ${v} at ${n} chatters`);
    prev = v;
  }
});

// ── The streamer's settings (ticket #189) ───────────────────────────────────

test("each rule's setting exists in the schema, and its default IS the product rule", () => {
  const rules = Object.keys(DEFAULT_AUTO_PIN) as (keyof AutoPinRules)[];
  assert.equal(rules.length, 5);
  for (const rule of rules) {
    const [key, scale] = AUTO_PIN_KEYS[rule];
    const e = INSTANCE_KEYS.find((k) => k.key === key);
    assert.ok(e, `${key} is not in the schema`);
    assert.equal(e.tier, "instance");
    assert.equal(e.reload, "live", `${key} must apply at the next vote, not at a restart`);
    assert.deepEqual(e.packages, ["web"]);
    if (rule === "off") {
      assert.equal(e.kind, "bool");
      assert.equal(e.default, DEFAULT_AUTO_PIN.off);
    } else {
      assert.equal(e.kind, "number");
      assert.equal(e.integer, true);
      assert.ok(typeof e.min === "number" && e.min >= 1, `${key} can be set to 0, which pins on any vote or never expires`);
      assert.equal(Number(e.default) * scale, DEFAULT_AUTO_PIN[rule], `${key}'s default differs from the product rule`);
    }
  }
  assert.equal(INSTANCE_KEYS.filter((k) => k.key.startsWith("chat.autoPin.")).length, 5, "no auto-pin setting without a rule");
});

test("autoPinRulesFrom reads each setting (minutes to ms); a value of the wrong type falls to that rule's default", () => {
  const vals: Record<string, unknown> = {
    "chat.autoPin.off": true, "chat.autoPin.votes": 5, "chat.autoPin.chattersPerVote": 20,
    "chat.autoPin.maxVotes": 9, "chat.autoPin.minutes": 3,
  };
  assert.deepEqual(autoPinRulesFrom((k) => vals[k]), { off: true, base: 5, chattersPerStep: 20, max: 9, ttlMs: 180_000 });
  const junk = autoPinRulesFrom((k) => (k === "chat.autoPin.votes" ? "lots" : k === "chat.autoPin.off" ? "yes" : null));
  assert.deepEqual(junk, { ...DEFAULT_AUTO_PIN });
});

test("the curve follows the settings it is GIVEN (each one, changed, moves the bar)", () => {
  const r: AutoPinRules = { off: false, base: 5, chattersPerStep: 20, max: 7, ttlMs: 60_000 };
  assert.equal(autoPinScore(null, r), 5, "unknown crowd = the streamer's base");
  assert.equal(autoPinScore(19, r), 5);
  assert.equal(autoPinScore(20, r), 6, "one step per 20 chatters");
  assert.equal(autoPinScore(10_000, r), 7, "the streamer's ceiling");
  assert.equal(autoPinScore(10_000, { ...r, max: 3 }), 5,
    "a ceiling set below the base must not LOWER the bar under the base");
  let prev = 0;
  for (let n = 0; n <= 500; n++) {
    const v = autoPinScore(n, r);
    assert.ok(v >= prev, `threshold fell from ${prev} to ${v} at ${n} chatters`);
    prev = v;
  }
});

test("the wait before an auto-pin expires follows the minutes setting", () => {
  const created = 1_000_000;
  assert.equal(autoPinWaitMs(created, created, DEFAULT_AUTO_PIN), 600_000);
  assert.equal(autoPinWaitMs(created, created + 120_000, { ...DEFAULT_AUTO_PIN, ttlMs: 180_000 }), 60_000);
  assert.equal(autoPinWaitMs(created, created + 999_999, DEFAULT_AUTO_PIN), 0, "overdue = due now, never negative");
});

/** A fake clock and timer queue for the expiry scheduler. */
function harness(ttlMs: number) {
  let now = 0;
  let rules: AutoPinRules = { ...DEFAULT_AUTO_PIN, ttlMs };
  const timers: { at: number; fn: () => void }[] = [];
  const expired: number[] = [];
  const deps = {
    nowMs: () => now,
    rules: () => rules,
    setTimer: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); },
    expire: async (id: number) => { expired.push(id); return true; },
  };
  return {
    deps, expired, timers,
    setRules: (r: Partial<AutoPinRules>) => { rules = { ...rules, ...r }; },
    async runUntil(t: number) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > t) break;
        timers.shift();
        now = next.at;
        next.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = t;
    },
  };
}

test("an auto-pin expires after the minutes the setting says", async () => {
  const h = harness(180_000);
  scheduleAutoPinExpiry(7, 0, h.deps);
  await h.runUntil(179_999);
  assert.deepEqual(h.expired, [], "expired early");
  await h.runUntil(180_000);
  assert.deepEqual(h.expired, [7]);
});

test("retry: minutes raised while a pin is up = the timer waits again instead of dropping the pin early", async () => {
  const h = harness(180_000);
  scheduleAutoPinExpiry(7, 0, h.deps);
  h.setRules({ ttlMs: 600_000 });
  await h.runUntil(180_000);
  assert.deepEqual(h.expired, [], "the pin came down on the old, shorter time");
  assert.equal(h.timers.length, 1, "the early timer did not arm itself again: the pin would stay up for good");
  await h.runUntil(600_000);
  assert.deepEqual(h.expired, [7]);
  assert.equal(h.timers.length, 0, "a timer is still armed after the pin expired");
});

test("restart: a pin from before a restart is expired on the next read by the CURRENT minutes setting", () => {
  // A restart drops the in-process timer; GET /api/chat/pin expires lazily. Both ask the same
  // question with the same rules, so a setting changed before the restart still applies after it.
  const route = read("../api/chat/pin/route.ts");
  const fn = route.slice(route.indexOf("export async function expireAutoPinIfDue"));
  assert.match(fn, /autoPinWaitMs\(createdAtMs, Date\.now\(\), autoPinRules\(\)\) > 0\) return false/,
    "the lazy expiry no longer reads the minutes setting");
  assert.doesNotMatch(route, /AUTO_PIN_TTL_MS/, "a fixed 10-minute TTL is back in the pin route");
});

// ── The chatter count ───────────────────────────────────────────────────────

function fakePool(impl: () => Promise<{ rows: { n: string }[] }>) {
  return { query: impl } as unknown as Parameters<typeof createActiveChatters>[0]["pool"];
}

test("the count is cached, so a busy chat does not COUNT(DISTINCT) per vote", async () => {
  let calls = 0;
  let now = 1_000;
  const { activeChatters } = createActiveChatters({
    pool: fakePool(async () => { calls++; return { rows: [{ n: "7" }] }; }),
    nowMs: () => now,
  });

  assert.equal(await activeChatters(), 7);
  assert.equal(await activeChatters(), 7);
  assert.equal(calls, 1, "the cache is not holding — every vote would hit the database");

  now += ACTIVE_CHATTERS_TTL_MS - 1;
  await activeChatters();
  assert.equal(calls, 1, "expired early");

  now += 1;
  await activeChatters();
  assert.equal(calls, 2, "the cache never expires — the count would freeze for the session");
});

test("a failed query is UNKNOWN, not zero, and is not retried per vote", async () => {
  let calls = 0;
  const now = 5_000;
  const { activeChatters } = createActiveChatters({
    pool: fakePool(async () => { calls++; throw new Error("db down"); }),
    nowMs: () => now,
  });

  assert.equal(await activeChatters(), null,
    "a failed count came back as a number — the threshold would be calibrated against a lie");
  await activeChatters();
  assert.equal(calls, 1, "a database that is down gets one COUNT(DISTINCT) per vote");
});

test("an empty or malformed row is unknown rather than NaN", async () => {
  const { activeChatters: noRows } = createActiveChatters({
    pool: fakePool(async () => ({ rows: [] })), nowMs: () => 0,
  });
  assert.equal(await noRows(), null);

  const { activeChatters: junk } = createActiveChatters({
    pool: fakePool(async () => ({ rows: [{ n: "not a number" }] })), nowMs: () => 0,
  });
  assert.equal(await junk(), null, "Number('not a number') is NaN, and NaN silently poisons the curve");
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test("the route reads the crowd only when the score could possibly clear the bar", () => {
  // Otherwise every vote on a quiet stream pays for a count that cannot change
  // the outcome. The cheap comparison has to come first.
  const route = read("../api/chat/vote/route.ts");
  const gate = route.indexOf("score >= rules.base");
  const call = route.indexOf("await activeChatters()");
  assert.ok(gate !== -1, "the route no longer short-circuits on the lowest possible threshold");
  assert.ok(call !== -1, "the route no longer scales the threshold with the crowd");
  assert.ok(gate < call, "the crowd is counted before the cheap score check that can rule it out");
});

test("the route reads the streamer's settings, honours the off switch and arms the setting's timer", () => {
  const route = read("../api/chat/vote/route.ts");
  assert.match(route, /const rules = autoPinRules\(\);/, "the vote route no longer reads the auto-pin settings");
  assert.match(route, /if \(!rules\.off && vote > 0 && score >= rules\.base\) \{/,
    "the off switch no longer stops the crowd pinning");
  assert.match(route, /autoPinScore\(await activeChatters\(\), rules\)/, "the curve is not fed the settings");
  assert.match(route, /scheduleAutoPinExpiry\(Number\(r\.id\), createdAtMs, \{/, "a new auto-pin arms no expiry");
  assert.doesNotMatch(route, /AUTO_PIN_TTL_MS|AUTO_PIN_BASE/, "a fixed auto-pin number is back in the vote route");
});

test("the threshold constant does not live in the route any more", () => {
  const route = read("../api/chat/vote/route.ts");
  assert.doesNotMatch(
    route, /const AUTO_PIN_SCORE\s*=/,
    "AUTO_PIN_SCORE is back in the route — it belongs in votePolicy with the other " +
    "vote numbers, where it is exported and can be tested"
  );
});

test("a mod's pin is never bumped by the crowd, and nothing re-pins", () => {
  // Both rules already existed and neither had a test. They are the reason
  // raising the threshold is safe to do at all: without them, a busier stream
  // would just churn the pin faster.
  const route = read("../api/chat/vote/route.ts");
  const fn = route.slice(route.indexOf("async function tryAutoPin"));
  assert.match(fn, /prior\.some\(\(r\) => r\.is_self\)\) return/,
    "a message with pin history can be re-pinned again");
  assert.match(fn, /prior\.some\(\(r\) => !r\.auto\)\) return/,
    "a mod's manual pin can now be silently replaced by crowd votes");
});

test("vacuity: the scans above read both routes to their END", () => {
  // The doesNotMatch checks pass over a short read; the last export of each route is the anchor.
  const vote = read("../api/chat/vote/route.ts");
  const pin = read("../api/chat/pin/route.ts");
  assert.match(vote.slice(-300), /auto-pin broadcast failed/, "the vote route was read short");
  assert.match(pin.slice(-400), /export async function DELETE\(\)/, "the pin route was read short");
});
