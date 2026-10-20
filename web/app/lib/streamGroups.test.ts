// Sessions → logical streams — the grouping rule's tests.
// Run: node --test app/lib/streamGroups.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveEndMs, groupSessions, visibleGroups, MERGE_GAP_MS, MIN_GROUP_MS } from "./streamGroups.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const row = (streamId: string, startedMs: number, endedMs: number | null, lastSnapMs: number | null) => ({ streamId, startedMs, endedMs, lastSnapMs });

test("effectiveEndMs trusts a sane ended_at", () => {
  assert.equal(effectiveEndMs(row("a", 0, 60 * MIN, 58 * MIN)), 60 * MIN);
});

test("effectiveEndMs caps a backfilled ended_at at the last snapshot + one heartbeat", () => {
  assert.equal(effectiveEndMs(row("a", 0, 6703 * MIN, 5 * MIN)), 15 * MIN);
});

test("effectiveEndMs gives a session with no snapshots zero length", () => {
  assert.equal(effectiveEndMs(row("test", 100, 4567 * MIN, null)), 100);
});

test("effectiveEndMs keeps an open session open", () => {
  assert.equal(effectiveEndMs(row("a", 0, null, 5 * MIN)), null);
});

test("groupSessions merges reconnects within the gap and keeps real streams apart, newest first", () => {
  const groups = groupSessions([
    row("a", 0, 5 * HOUR, 5 * HOUR - MIN),
    row("b", 5 * HOUR + 3 * MIN, 9 * HOUR, 9 * HOUR - MIN),
    row("c", 29 * HOUR, 35 * HOUR, 35 * HOUR - MIN),
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.streamIds, ["c"]);
  assert.deepEqual(groups[1]!.streamIds, ["a", "b"]);
  assert.equal(groups[1]!.startedMs, 0);
  assert.equal(groups[1]!.endedMs, 9 * HOUR);
  assert.equal(groups[1]!.durationMs, 9 * HOUR);
  assert.equal(groups[1]!.segments, 2);
});

test("groupSessions merges overlapping sessions (a negative gap); the group ends at the latest effective end", () => {
  const groups = groupSessions([row("a", 0, 4 * HOUR, 30 * MIN), row("b", 6 * MIN, 10 * MIN, 8 * MIN)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.streamIds, ["a", "b"]);
  assert.equal(groups[0]!.endedMs, 40 * MIN);
});

test("groupSessions takes input in any order", () => {
  const groups = groupSessions([row("new", 100 * HOUR, 105 * HOUR, 105 * HOUR), row("old", 0, 4 * HOUR, 4 * HOUR)]);
  assert.deepEqual(groups.map((g) => g.streamIds[0]), ["new", "old"]);
});

test("an open session leaves its group open", () => {
  const groups = groupSessions([row("a", 0, 20 * MIN, 19 * MIN), row("b", 25 * MIN, null, 30 * MIN)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.endedMs, null);
  assert.equal(groups[0]!.durationMs, null);
});

test("gap boundary: exactly MERGE_GAP_MS merges, a millisecond more does not", () => {
  assert.equal(MERGE_GAP_MS, 60 * MIN);
  assert.equal(groupSessions([row("a", 0, HOUR, HOUR), row("b", HOUR + MERGE_GAP_MS, 3 * HOUR, 3 * HOUR)]).length, 1);
  assert.equal(groupSessions([row("a", 0, HOUR, HOUR), row("b", HOUR + MERGE_GAP_MS + 1, 3 * HOUR, 3 * HOUR)]).length, 2);
});

test("visibleGroups drops closed groups under 10 minutes and keeps an open one", () => {
  assert.equal(MIN_GROUP_MS, 10 * MIN);
  const groups = groupSessions([
    row("blip", 0, MIN, 30_000),
    row("real", 24 * HOUR, 30 * HOUR, 30 * HOUR),
    row("live", 100 * HOUR, null, 100 * HOUR + 5 * MIN),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(visibleGroups(groups).map((g) => g.streamIds[0]), ["live", "real"]);
});

test("no sessions → no groups", () => {
  assert.deepEqual(groupSessions([]), []);
  assert.deepEqual(visibleGroups([]), []);
});
