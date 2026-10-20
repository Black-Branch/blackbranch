// The Stream tab's pure derivations and its chart math.
// Run: node --test app/lib/streamStats.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  int, fillMinuteBuckets, durationMinutes, fmtDuration, fmtMoney, sortSessions, isSessionSort, composition,
  earnedCurve, hourlyRate, byPlatform, healthSummary, type SessionSummary, type SupportEvent,
} from "./streamStats.ts";
import { areaPath, linePath, scale, stepPath } from "./chartPath.ts";

const MIN = 60_000;

test("int parses pg bigint strings and refuses anything that is not a safe integer", () => {
  assert.equal(int("12345", "x"), 12345);
  assert.equal(int(7, "x"), 7);
  assert.throws(() => int("12.5", "x"), /non-integer x/);
  assert.throws(() => int(null, "x"), /non-integer x/);
});

test("fillMinuteBuckets zero-fills, oldest first, floors the end to its minute, sums a minute's rows", () => {
  const out = fillMinuteBuckets([{ minuteMs: 9 * MIN, count: 3 }, { minuteMs: 9 * MIN, count: 2 }, { minuteMs: 7 * MIN, count: 1 }], 10 * MIN + 30_000, 4);
  assert.deepEqual(out.map((b) => b.ms), [7 * MIN, 8 * MIN, 9 * MIN, 10 * MIN]);
  assert.deepEqual(out.map((b) => b.total), [1, 0, 5, 0]);
});

test("durations and money read the way the tab prints them", () => {
  assert.equal(durationMinutes(0, 90_000), 2);
  assert.equal(durationMinutes(90_000, 0), 0);
  assert.equal(fmtDuration(47), "47m");
  assert.equal(fmtDuration(185), "3h 05m");
  assert.equal(fmtMoney(12809), "$128.09");
  assert.equal(fmtMoney(12809, true), "$128");
});

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  streamId: "s", segments: 1, startedMs: 0, endedMs: 1, durationMs: 1, peakViewers: 0, avgViewers: 0, messages: 0, earnedCents: 0, ...over,
});

test("sortSessions: biggest first, ties newest first; a live stream is the longest", () => {
  const a = summary({ streamId: "a", startedMs: 1, peakViewers: 10, durationMs: 50, earnedCents: 300 });
  const b = summary({ streamId: "b", startedMs: 2, peakViewers: 30, durationMs: 20, earnedCents: 100 });
  const c = summary({ streamId: "c", startedMs: 3, peakViewers: 10, durationMs: null, endedMs: null, earnedCents: 200 });
  assert.deepEqual(sortSessions([a, b, c], "date").map((s) => s.streamId), ["c", "b", "a"]);
  assert.deepEqual(sortSessions([a, b, c], "viewers").map((s) => s.streamId), ["b", "c", "a"]);
  assert.deepEqual(sortSessions([a, b, c], "duration").map((s) => s.streamId), ["c", "a", "b"]);
  assert.deepEqual(sortSessions([a, b, c], "earned").map((s) => s.streamId), ["a", "c", "b"]);
});

test("sorting by earned without income is date order — the order of streams by money must not leak with income hidden", () => {
  const a = summary({ streamId: "a", startedMs: 1, earnedCents: null });
  const b = summary({ streamId: "b", startedMs: 2, earnedCents: null });
  assert.deepEqual(sortSessions([a, b], "earned").map((s) => s.streamId), ["b", "a"]);
  assert.ok(isSessionSort("earned") && isSessionSort("duration") && !isSessionSort("money") && !isSessionSort(undefined));
});

test("composition: each platform's share, in stack order, empty platforms left out", () => {
  assert.deepEqual(composition(null), []);
  assert.deepEqual(composition({ twitch: 0, youtube: null, kick: 0, streamplace: 0, total: 0 }), []);
  const c = composition({ twitch: 30, youtube: 10, kick: null, streamplace: 0, total: 40 });
  assert.deepEqual(c.map((x) => [x.platform, x.share]), [["twitch", 0.75], ["youtube", 0.25]]);
});

const ev = (id: number, ms: number, cents: number, platform = "twitch"): SupportEvent => ({ id, ms, platform, username: "casey", eventType: null, cents });

test("earnedCurve: a step per payment from zero at the start to the total at the end, in time order", () => {
  const out = earnedCurve([ev(2, 30 * MIN, 500), ev(1, 10 * MIN, 250)], 0, 60 * MIN);
  assert.deepEqual(out, [{ ms: 0, cents: 0 }, { ms: 10 * MIN, cents: 250 }, { ms: 30 * MIN, cents: 750 }, { ms: 60 * MIN, cents: 750 }]);
  assert.deepEqual(earnedCurve([], 0, MIN), [{ ms: 0, cents: 0 }, { ms: MIN, cents: 0 }]);
});

test("hourlyRate and byPlatform", () => {
  assert.equal(hourlyRate(1000, 0, 2 * 60 * MIN), 500);
  assert.equal(hourlyRate(1000, 0, 30_000), 0, "under a minute has no rate");
  assert.deepEqual(byPlatform([ev(1, 0, 100), ev(2, 0, 50, "kofi"), ev(3, 0, 25)]), { twitch: 125, kofi: 50 });
});

test("healthSummary counts each verdict and names the first failing check, else the first warning", () => {
  const s = healthSummary([
    { id: "a", title: "A", status: "ok" }, { id: "b", title: "B", status: "warn" },
    { id: "c", title: "C", status: "fail" }, { id: "d", title: "D", status: "grey" }, { id: "e", title: "E", status: "ok" },
  ]);
  assert.deepEqual(s.counts, { ok: 2, warn: 1, fail: 1, grey: 1 });
  assert.equal(s.worst?.id, "c");
  assert.equal(healthSummary([{ id: "b", title: "B", status: "warn" }]).worst?.id, "b");
  assert.equal(healthSummary([{ id: "a", title: "A", status: "ok" }]).worst, null);
});

test("chart paths: line, area to a baseline, steps, and a scale that survives a zero-width domain", () => {
  assert.equal(linePath([[0, 10], [5.55, 2]]), "M0,10 L5.6,2");
  assert.equal(areaPath([[0, 10], [5, 2]], 20), "M0,10 L5,2 L5,20 L0,20 Z");
  assert.equal(areaPath([], 20), "");
  assert.equal(stepPath([[0, 10], [5, 6], [9, 2]]), "M0,10 L5,10 L5,6 L9,6 L9,2");
  assert.equal(scale(0, 10, 0, 100)(5), 50);
  assert.equal(scale(0, 10, 100, 0)(10), 0);
  assert.equal(scale(3, 3, 7, 9)(3), 7);
});
