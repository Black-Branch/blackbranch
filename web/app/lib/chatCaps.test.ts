// Behavior › Chat history length.
// (An old "Reduced chat history" ON becomes Short in storage — settingsMigrate.test.ts.)
// Run: node --test app/lib/chatCaps.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { historyCaps } from "./chatCaps.ts";

test("Short · Default · Long keep 50/300 · 80/1000 · 150/2000 rows", () => {
  assert.deepEqual(historyCaps("short"), { live: 50, scrollback: 300 });
  assert.deepEqual(historyCaps("default"), { live: 80, scrollback: 1000 });
  assert.deepEqual(historyCaps("long"), { live: 150, scrollback: 2000 });
});

test("nothing saved, or junk, = Default", () => {
  assert.deepEqual(historyCaps(null), { live: 80, scrollback: 1000 });
  assert.deepEqual(historyCaps("huge"), { live: 80, scrollback: 1000 });
  assert.deepEqual(historyCaps("constructor"), { live: 80, scrollback: 1000 });
});
