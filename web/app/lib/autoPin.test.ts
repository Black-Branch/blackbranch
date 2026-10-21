// The crowd auto-pin threshold, and the guards around it.
//
// The threshold scales with active chatters, so a pin at 3 points does not
// come too cheaply on a busy stream.
//
// Pinning costs no points: there is no `pin` row in site.store_prices and no
// /api/points/spend/pin. The threshold is `AUTO_PIN_SCORE`, a NET-UPVOTE
// count — casting a vote *earns* 1 point, which can make it read like a price.
//
// This file covers the threshold, the 10-minute TTL and tryAutoPin's "never
// bump a mod's pin" rule; the constant is exported so a change to it has
// something to say about it.
//
// Run: node --test app/lib/autoPin.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  autoPinScore, AUTO_PIN_BASE, AUTO_PIN_CHATTERS_PER_STEP, AUTO_PIN_MAX,
} from "./votePolicy.ts";
import { createActiveChatters, ACTIVE_CHATTERS_TTL_MS } from "./activeChatters.ts";

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

test("it is monotonic — a bigger crowd never lowers the bar", () => {
  let prev = 0;
  for (let n = 0; n <= 200; n++) {
    const v = autoPinScore(n);
    assert.ok(v >= prev, `threshold fell from ${prev} to ${v} at ${n} chatters`);
    prev = v;
  }
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
  const gate = route.indexOf("score >= AUTO_PIN_BASE");
  const call = route.indexOf("await activeChatters()");
  assert.ok(gate !== -1, "the route no longer short-circuits on the lowest possible threshold");
  assert.ok(call !== -1, "the route no longer scales the threshold with the crowd");
  assert.ok(gate < call, "the crowd is counted before the cheap score check that can rule it out");
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
