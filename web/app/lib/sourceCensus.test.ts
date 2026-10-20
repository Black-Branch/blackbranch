// Tests for the per-source viewer census.
//
// WHY THIS IS PURE. The count has to be right before anyone makes a decision
// with it — its purpose is to cut a source on evidence rather than impression
// — and a count that quietly drifts is worse than no count. The map and the
// clock are injected so every rule here is provable without a server.
//
// Run: node --test app/lib/sourceCensus.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countSources, createFlushGate, dueForFlush, hasFreshEntry, parseCensusSource, parseTabId, recordSample,
  FLUSH_EVERY_MS, SAMPLE_TTL_MS, MAP_CAP, EVICT_ABOVE, type CensusMap, type CensusSource,
} from "./sourceCensus.ts";

const fresh = (): CensusMap => new Map();

test("a source with no viewers reports 0, never a missing key", () => {
  // A reader must never have to tell "nobody" from "we did not measure".
  const c = countSources(fresh(), 1000);
  for (const k of ["native", "streamplace", "youtube", "twitch", "community", "radio", "none"]) {
    assert.equal(c[k as keyof typeof c], 0, `${k} must be present and zero`);
  }
});

test("two tabs on one source count twice; one tab counts once however often it polls", () => {
  const m = fresh();
  recordSample(m, "aaa", "twitch", 1000);
  recordSample(m, "bbb", "twitch", 1000);
  recordSample(m, "aaa", "twitch", 1500);
  assert.equal(countSources(m, 2000).twitch, 2);
});

test("a tab that switches source moves, it does not double-count", () => {
  const m = fresh();
  recordSample(m, "aaa", "youtube", 1000);
  recordSample(m, "aaa", "twitch", 1200);
  const c = countSources(m, 1300);
  assert.equal(c.youtube, 0);
  assert.equal(c.twitch, 1);
});

test("a sample expires at exactly the TTL, not before", () => {
  const m = fresh();
  recordSample(m, "aaa", "native", 1000);
  assert.equal(countSources(m, 1000 + SAMPLE_TTL_MS - 1).native, 1, "still live one ms early");
  assert.equal(countSources(m, 1000 + SAMPLE_TTL_MS).native, 0, "gone at the boundary");
});

test("the TTL survives one missed poll", () => {
  // The client polls every 30s. A TTL under 60s would drop a viewer whose
  // single poll was lost, and undercount exactly when the network is worst.
  assert.ok(SAMPLE_TTL_MS >= 60_000, "a viewer must survive one missed 30s poll");
});

test("a folded player is counted, under its own key", () => {
  const m = fresh();
  recordSample(m, "aaa", "none", 1000);
  assert.equal(countSources(m, 1100).none, 1);
});

test("only the closed vocabulary parses", () => {
  for (const ok of ["native", "streamplace", "youtube", "twitch", "community", "radio", "none"]) {
    assert.equal(parseCensusSource(ok), ok);
  }
  for (const junk of [null, "", "kick", "NONE", "radio ", "__proto__", "constructor"]) {
    assert.equal(parseCensusSource(junk), null, `"${junk}" must not parse as a source`);
  }
});

test("a tab id is bounded and alphanumeric — it becomes a map key", () => {
  assert.equal(parseTabId("a1b2c3d4"), "a1b2c3d4");
  for (const junk of [null, "", "has space", "a".repeat(65), "semi;colon", "../x"]) {
    assert.equal(parseTabId(junk), null, `"${String(junk)}" must not parse as a tab id`);
  }
});

test("a new id is refused once the map is at the cap; an id already tracked still refreshes", () => {
  // Built directly rather than via MAP_CAP calls to recordSample: this pins
  // the boundary itself, not the cost of getting there.
  const m: CensusMap = new Map();
  for (let i = 0; i < MAP_CAP; i++) m.set(`id${i}`, { source: "twitch", at: 1000 });

  recordSample(m, "brandnew", "youtube", 1000);
  assert.equal(m.size, MAP_CAP, "a new id must not grow the map past the cap");
  assert.equal(m.has("brandnew"), false, "the refused id must not appear at all");

  recordSample(m, "id0", "youtube", 2000);
  assert.equal(m.size, MAP_CAP, "refreshing an already-tracked id must not change the size");
  assert.deepEqual(m.get("id0"), { source: "youtube", at: 2000 },
    "an id already tracked must still refresh at the cap");
});

test("the map cannot exceed the cap however many distinct ids arrive", () => {
  const m: CensusMap = new Map();
  for (let i = 0; i < MAP_CAP - 3; i++) m.set(`id${i}`, { source: "twitch", at: 1000 });
  for (let i = 0; i < 10; i++) recordSample(m, `new${i}`, "youtube", 1000);
  assert.equal(m.size, MAP_CAP,
    "only enough new ids to reach the cap may be admitted; the rest must be refused");
});

test("the eviction sweep actually deletes stale entries once the map passes EVICT_ABOVE — without it, a long-lived process would freeze on tabs that closed hours ago", () => {
  // Both cap tests above build their map directly and read it back at the
  // SAME timestamp, so the `delete` branch inside recordSample is never once
  // exercised by them. This is what exercises it: every entry is planted
  // already past SAMPLE_TTL_MS, well above EVICT_ABOVE, and recorded once —
  // if the sweep runs, almost the entire map must be gone afterward.
  const m: CensusMap = new Map();
  const staleAt = 1_000_000;
  for (let i = 0; i < EVICT_ABOVE + 1; i++) m.set(`stale${i}`, { source: "twitch", at: staleAt });
  const now = staleAt + SAMPLE_TTL_MS + 1;

  recordSample(m, "brandnew", "youtube", now);

  // Every planted entry was stale at `now`; only the freshly-recorded id
  // should survive a real sweep. A map that still has all the old entries
  // means the `if (map.size > EVICT_ABOVE)` block was deleted or never ran.
  assert.equal(m.size, 1, "the sweep must have removed every stale entry, leaving only the new one");
  assert.equal(m.has("brandnew"), true, "the newly-recorded id must still be present");
});

test("hasFreshEntry: an empty map is not fresh", () => {
  assert.equal(hasFreshEntry(fresh(), 1000), false);
});

test("hasFreshEntry: a map holding only entries older than the sample TTL is not fresh", () => {
  const m = fresh();
  recordSample(m, "aaa", "twitch", 1000);
  recordSample(m, "bbb", "youtube", 1000);
  assert.equal(hasFreshEntry(m, 1000 + SAMPLE_TTL_MS), false, "both entries are past the TTL by now");
});

test("hasFreshEntry: a map with one fresh entry among stale ones is fresh", () => {
  const m = fresh();
  recordSample(m, "stale", "twitch", 1000);
  recordSample(m, "fresh", "youtube", 1000 + SAMPLE_TTL_MS - 1);
  assert.equal(hasFreshEntry(m, 1000 + SAMPLE_TTL_MS), true,
    "the second entry is one ms old at `now` and must count as fresh");
});

test("hasFreshEntry stops at the first fresh entry rather than walking the rest — the whole point of the short-circuit", () => {
  // The fresh entry is inserted FIRST, so it is first in Map iteration order;
  // 50 long-stale entries follow it. `.values()` is wrapped to count how many
  // times the underlying iterator is actually pulled — a full walk would pull
  // 51 times, a short-circuit exactly 1.
  const m: CensusMap = new Map();
  recordSample(m, "fresh", "twitch", 1000);
  for (let i = 0; i < 50; i++) recordSample(m, `stale${i}`, "youtube", 0);

  let pulls = 0;
  const realValues = m.values.bind(m);
  m.values = (): MapIterator<{ source: CensusSource; at: number }> => {
    const it = realValues();
    return {
      [Symbol.iterator]() { return this; },
      next: () => { pulls += 1; return it.next(); },
    } as MapIterator<{ source: CensusSource; at: number }>;
  };

  const now = 1000 + SAMPLE_TTL_MS - 1; // the "fresh" entry (at=1000) is still fresh; the rest (at=0) are long gone
  assert.equal(hasFreshEntry(m, now), true);
  assert.equal(pulls, 1, "must stop after the first, fresh entry rather than scanning the other 50 stale ones");
});

test("flush is due on the boundary and not before", () => {
  assert.equal(dueForFlush(1000, 1000 + FLUSH_EVERY_MS - 1), false);
  assert.equal(dueForFlush(1000, 1000 + FLUSH_EVERY_MS), true);
});

test("a never-flushed census is due immediately", () => {
  assert.equal(dueForFlush(0, 1), true);
});

test("two genuinely overlapping flushes: the second is refused while the first is still running, and a later one is allowed once it finishes and the interval has passed", () => {
  const gate = createFlushGate();
  assert.equal(gate.beginIfDue(1000), true, "the first flush is due and nothing is running");
  // The interval alone would say yes here — dueForFlush(1000, 1000+FLUSH_EVERY_MS)
  // is true — so this specifically exercises the in-flight flag, not the timer.
  assert.equal(gate.beginIfDue(1000 + FLUSH_EVERY_MS), false,
    "a second flush must be refused while the first has not finished, even once the interval has elapsed");
  gate.finish();
  assert.equal(gate.beginIfDue(1000 + FLUSH_EVERY_MS), true,
    "once the first flush finishes and the interval has passed, a new flush may begin");
});

test("a flush that never finishes refuses every later attempt — the deliberate trade createFlushGate documents", () => {
  const gate = createFlushGate();
  assert.equal(gate.beginIfDue(1000), true);
  // finish() is never called — this is what an INSERT that HANGS rather than
  // rejecting looks like from the gate's point of view.
  assert.equal(gate.beginIfDue(1000 + FLUSH_EVERY_MS), false,
    "a stranded in-flight flag must refuse the very next attempt");
  assert.equal(gate.beginIfDue(1000 + FLUSH_EVERY_MS * 1000), false,
    "and every attempt after that, arbitrarily far in the future — this is a process-lifetime trade, not a timing bug");
});
