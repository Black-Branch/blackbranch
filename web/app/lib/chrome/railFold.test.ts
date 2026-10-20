// Run: node --test app/lib/chrome/railFold.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { openGroups, visibleRailItems, hasChildren } from "./railFold.ts";

const items = [
  { key: "ai/models", group: "AI" }, { key: "ai/bot", group: "AI" }, { key: "ai/behavior", group: "AI", depth: 1 as const },
  { key: "utility/obs", group: "Utility" }, { key: "utility/timer", group: "Utility", depth: 1 as const },
  { key: "utility/bar", group: "Utility", depth: 1 as const }, { key: "utility/tts", group: "Utility" },
  { key: "doctor", group: "Install" },
];
const keys = (v: string | null, stored: string[] = [], all = false) =>
  visibleRailItems(items, v, openGroups(items, v, stored, all), all).map((x) => x.key);

test("only the selected place's group is open by default; nested places fold under their parent", () => {
  assert.deepEqual(keys("ai/models"), ["ai/models", "ai/bot"]);
});

test("a nested place shows while its parent or a sibling is selected", () => {
  assert.deepEqual(keys("ai/bot"), ["ai/models", "ai/bot", "ai/behavior"]);
  assert.deepEqual(keys("utility/timer"), ["utility/obs", "utility/timer", "utility/bar", "utility/tts"]);
});

test("a stored open group shows its places (nested ones still folded)", () => {
  assert.deepEqual(keys("ai/models", ["Install", "Utility"]), ["ai/models", "ai/bot", "utility/obs", "utility/tts", "doctor"]);
});

test("a search opens everything", () => {
  assert.deepEqual(keys("ai/models", [], true), items.map((x) => x.key));
});

test("hasChildren marks a parent only", () => {
  assert.equal(hasChildren(items, "ai/bot"), true);
  assert.equal(hasChildren(items, "utility/obs"), true);
  assert.equal(hasChildren(items, "ai/models"), false);
  assert.equal(hasChildren(items, "utility/timer"), false);
});
