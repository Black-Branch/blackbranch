// Tests for badge render order (pure, node --test).
//
// Run: node --test app/lib/badgeOrder.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { badgesInRenderOrder } from "./badgeOrder.ts";

const MOD = { id: 1, name: "Mod", imageUrl: "/mod.png" };
const SUB = { id: 2, name: "Subscriber", imageUrl: "/sub.png" };
const FUN = { id: 3, name: "Fun", imageUrl: "/fun.png" };

const state = (u: { isMod: boolean; equipped: (number | null)[]; slotCount: number }) => ({
  byId: { 1: MOD, 2: SUB, 3: FUN },
  modBadgeId: 1,
  perUser: { "@a:site.test": { ...u, unlocked: [2, 3] } as never },
});

const names = (b: { name: string }[]) => b.map((x) => x.name);

test("a subscribed mod renders subscriber BEFORE mod", () => {
  const out = badgesInRenderOrder(state({ isMod: true, equipped: [2], slotCount: 1 }), "@a:site.test");
  assert.deepEqual(names(out), ["Subscriber", "Mod"]);
});

test("the mod badge is a SUFFIX — it sits after every equipped badge", () => {
  // Pins the rule as "mod last", not "mod second". A mod with several badges
  // equipped should not have the fixed badge shoved into the middle of slots
  // they chose the order of.
  const out = badgesInRenderOrder(state({ isMod: true, equipped: [2, 3], slotCount: 2 }), "@a:site.test");
  assert.deepEqual(names(out), ["Subscriber", "Fun", "Mod"]);
});

test("the subscriber badge is NOT special-cased — slot order decides", () => {
  // Deliberate (see badgeOrder.ts). If the user equips Fun in slot 1 and
  // Subscriber in slot 2, that is what renders — hoisting Subscriber would make
  // their slot choice a lie.
  const out = badgesInRenderOrder(state({ isMod: false, equipped: [3, 2], slotCount: 2 }), "@a:site.test");
  assert.deepEqual(names(out), ["Fun", "Subscriber"]);
});

test("a non-mod gets no mod badge, however the slots are arranged", () => {
  const out = badgesInRenderOrder(state({ isMod: false, equipped: [2], slotCount: 1 }), "@a:site.test");
  assert.deepEqual(names(out), ["Subscriber"]);
});

test("a mod with no equipped badges still shows the mod badge", () => {
  // The suffix must not depend on there being something to suffix.
  const out = badgesInRenderOrder(state({ isMod: true, equipped: [], slotCount: 0 }), "@a:site.test");
  assert.deepEqual(names(out), ["Mod"]);
});

test("locked slots are skipped even when something is equipped in them", () => {
  // slotCount is the entitlement; equipped can outlive a lapsed subscription.
  // Rendering a badge from a slot the user no longer has would show a perk they
  // stopped paying for.
  const out = badgesInRenderOrder(state({ isMod: false, equipped: [2, 3], slotCount: 1 }), "@a:site.test");
  assert.deepEqual(names(out), ["Subscriber"]);
});

test("an empty slot is skipped, not rendered as a gap", () => {
  const out = badgesInRenderOrder(state({ isMod: true, equipped: [null, 3], slotCount: 2 }), "@a:site.test");
  assert.deepEqual(names(out), ["Fun", "Mod"]);
});

test("a platform-only chatter (no matrix id) has no badges", () => {
  assert.deepEqual(badgesInRenderOrder(state({ isMod: true, equipped: [2], slotCount: 1 }), null), []);
  assert.deepEqual(badgesInRenderOrder(state({ isMod: true, equipped: [2], slotCount: 1 }), undefined), []);
});

test("an unknown user is empty, not a crash", () => {
  assert.deepEqual(badgesInRenderOrder(state({ isMod: true, equipped: [2], slotCount: 1 }), "@nobody:site.test"), []);
});
