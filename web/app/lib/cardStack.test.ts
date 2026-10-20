import { test } from "node:test";
import assert from "node:assert/strict";
import { pushPage, popPage } from "./cardStack.ts";

const ROOT = { key: "profile", title: "Profile" };
const APPEARANCE = { key: "appearance", title: "Chat appearance" };

test("pushing adds a page and deepens the stack", () => {
  const s = pushPage([ROOT], APPEARANCE);
  assert.deepEqual(s.map((p) => p.key), ["profile", "appearance"]);
  assert.equal(s.length, 2);
});

test("pushing the page already on top is a no-op", () => {
  // Re-firing bb:open-chat-appearance while it is open must not stack two
  // copies — the back arrow would then need two presses to reach the root.
  const s = pushPage(pushPage([ROOT], APPEARANCE), APPEARANCE);
  assert.deepEqual(s.map((p) => p.key), ["profile", "appearance"]);
});

test("pushing a page already deeper in the stack unwinds to it", () => {
  // Store → Support → Store should land on Store at depth 2, not depth 3 with a
  // duplicate underneath.
  const store = { key: "store", title: "Qorm" };
  const support = { key: "support", title: "Support" };
  const s = pushPage(pushPage(pushPage([ROOT], store), support), store);
  assert.deepEqual(s.map((p) => p.key), ["profile", "store"]);
});

test("popping removes the top page", () => {
  assert.deepEqual(popPage(pushPage([ROOT], APPEARANCE)).map((p) => p.key), ["profile"]);
});

test("popping the root is a no-op — the card never empties", () => {
  assert.deepEqual(popPage([ROOT]), [ROOT]);
  assert.equal(popPage([ROOT]).length, 1);
});

test("the stack is never mutated in place", () => {
  const before = [ROOT];
  pushPage(before, APPEARANCE);
  assert.equal(before.length, 1, "pushPage mutated its input");
});
