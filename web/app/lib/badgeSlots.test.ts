// Disclosure rules for the PUBLIC GET /api/badges response.
// Run: node --test app/lib/badgeSlots.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeBadgeUserState } from "./badgeSlots.ts";

const base = {
  isSelf: false, ownedSlotCount: 1, equipped: [], unlocked: [], isMod: false,
  entitled: true, subscriberBadgeIds: new Set<number>(),
};

test("THE LEAK: a subscriber who equips nothing is omitted entirely", () => {
  // Their entitlement showed up as ownedSlotCount = base + 1 on a public,
  // every-client-polled endpoint. Absence is the only way to not say it.
  assert.equal(shapeBadgeUserState({ ...base, ownedSlotCount: 1, equipped: [null] }), null);
});

test("a gift recipient / unlock owner with nothing equipped is omitted too", () => {
  assert.equal(shapeBadgeUserState({ ...base, unlocked: [7, 9], equipped: [] }), null);
  assert.equal(shapeBadgeUserState({ ...base, unlocked: [7], equipped: [null, null] }), null);
});

test("the private inventory never ships for anyone but the caller", () => {
  const r = shapeBadgeUserState({ ...base, equipped: [4], unlocked: [4, 5, 6] });
  assert.deepEqual(r?.unlocked, [], "unlocked is the list of what they bought but chose not to show");
});

test("owned slot count never ships for others — only what is displayed", () => {
  // Owns 3 slots, displays 1. Reporting 3 would re-leak the entitlement.
  const r = shapeBadgeUserState({ ...base, ownedSlotCount: 3, equipped: [4, null, null] });
  assert.equal(r?.slotCount, 1);
  assert.deepEqual(r?.equipped, [4]);
});

test("mods are still visible even with nothing equipped — the mod badge is public", () => {
  const r = shapeBadgeUserState({ ...base, isMod: true, equipped: [] });
  assert.equal(r?.isMod, true);
  assert.equal(r?.slotCount, 0);
});

test("NO PUBLIC BADGE DISAPPEARS: equipped badges survive unchanged", () => {
  const r = shapeBadgeUserState({ ...base, ownedSlotCount: 2, equipped: [4, 5] });
  assert.deepEqual(r?.equipped, [4, 5]);
  assert.equal(r?.slotCount, 2, "both still render");
});

test("a badge in a slot they no longer hold is dropped, not rendered", () => {
  // Subscription lapsed: owned drops to 1 while equipped still lists 2.
  const r = shapeBadgeUserState({ ...base, ownedSlotCount: 1, equipped: [4, 5] });
  assert.deepEqual(r?.equipped, [4]);
});

test("an interior gap is preserved so slot order is not shifted", () => {
  const r = shapeBadgeUserState({ ...base, ownedSlotCount: 3, equipped: [null, 5, null] });
  assert.deepEqual(r?.equipped, [null, 5]);
  assert.equal(r?.slotCount, 2, "badge 5 keeps its slot position");
});

test("SELF gets the full picture — the equip palette needs it", () => {
  const r = shapeBadgeUserState({
    isSelf: true, ownedSlotCount: 3, equipped: [4, null, null], unlocked: [4, 5, 6], isMod: false,
    entitled: true, subscriberBadgeIds: new Set<number>(),
  });
  assert.equal(r?.slotCount, 3, "own OWNED slots, so empty slots render as equippable");
  assert.deepEqual(r?.unlocked, [4, 5, 6], "own inventory is the palette");
  assert.deepEqual(r?.equipped, [4, null, null], "not trimmed — empty slots are targets");
});

test("self is never omitted, even with nothing at all", () => {
  const r = shapeBadgeUserState({ ...base, isSelf: true, ownedSlotCount: 0, equipped: [] });
  assert.notEqual(r, null);
});

// ── A subscriber-gated badge is worn only while entitlement is live ──
const SUB_BADGE = 1;
const gated = { ...base, subscriberBadgeIds: new Set([SUB_BADGE]) };

test("the resurface: lapse, buy a slot, and the stale Supporter badge must NOT reappear", () => {
  // equip/route.ts 403s a FRESH equip without entitlement, but the equipped
  // array persists a lapse — a bought slot could bring the badge back with
  // no equip call for the route to refuse.
  const r = shapeBadgeUserState({ ...gated, entitled: false, ownedSlotCount: 1, equipped: [SUB_BADGE] });
  assert.equal(r, null, "a lapsed subscriber is wearing the Supporter badge again");
});

test("a lapsed user's OTHER badges keep rendering — only the gated one is masked", () => {
  const r = shapeBadgeUserState({ ...gated, entitled: false, ownedSlotCount: 2, equipped: [SUB_BADGE, 4] });
  assert.deepEqual(r?.equipped, [null, 4], "the gated badge must mask to an empty slot, not hide the row");
});

test("self view masks too — the equip UI must agree with what chat shows", () => {
  const r = shapeBadgeUserState({ ...gated, isSelf: true, entitled: false, equipped: [SUB_BADGE] });
  assert.deepEqual(r?.equipped, [null]);
});

test("live entitlement wears the badge exactly as before; non-gated ids never mask", () => {
  const on = shapeBadgeUserState({ ...gated, entitled: true, equipped: [SUB_BADGE] });
  assert.deepEqual(on?.equipped, [SUB_BADGE]);
  const other = shapeBadgeUserState({ ...gated, entitled: false, ownedSlotCount: 1, equipped: [4] });
  assert.deepEqual(other?.equipped, [4], "an unrelated badge got caught in the entitlement mask");
});
