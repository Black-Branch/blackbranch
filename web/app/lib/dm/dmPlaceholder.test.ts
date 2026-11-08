// The chat box while a DM window holds it says who the line goes to: "Message <name>", one line at
// 390 px — a long name is cut in code, never by the field wrapping.
// Run: node --test app/lib/dm/dmPlaceholder.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dmPlaceholder } from "./dmPlaceholder.ts";

test("short label", () => {
  assert.equal(dmPlaceholder("casey"), "Message casey");
});

test("a 24-character label is kept whole", () => {
  const l = "a".repeat(24);
  assert.equal(dmPlaceholder(l), `Message ${l}`);
});

test("a 32-character label → exactly \"Message \" + 23 chars + \"…\"", () => {
  const l = "abcdefghijklmnopqrstuvwxyz012345";
  assert.equal(l.length, 32);
  assert.equal(dmPlaceholder(l), "Message " + l.slice(0, 23) + "…");
});
