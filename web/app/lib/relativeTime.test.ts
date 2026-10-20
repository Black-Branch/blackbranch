import { test } from "node:test";
import assert from "node:assert/strict";
import { agoLabel, durationLabel } from "./relativeTime.ts";

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const at = (ms: number) => new Date(T0 - ms).toISOString();

test("agoLabel rounds to the largest unit that fits", () => {
  assert.equal(agoLabel(at(20_000), T0), "just now");
  assert.equal(agoLabel(at(5 * 60_000), T0), "5m ago");
  assert.equal(agoLabel(at(3 * 3_600_000), T0), "3h ago");
  assert.equal(agoLabel(at(2 * 86_400_000), T0), "2d ago");
  assert.equal(agoLabel(at(21 * 86_400_000), T0), "3w ago");
});

test("agoLabel never says the future or throws on junk", () => {
  assert.equal(agoLabel(at(-60_000), T0), "just now");
  assert.equal(agoLabel("not a date", T0), "");
});

test("durationLabel", () => {
  assert.equal(durationLabel(8 * 3_600_000 + 55 * 60_000), "8h 55m");
  assert.equal(durationLabel(42 * 60_000), "42m");
  assert.equal(durationLabel(0), "0m");
  assert.equal(durationLabel(-5), "0m");
});
