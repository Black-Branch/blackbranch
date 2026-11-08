// A member's name as every Community slot shows it (client polish Task 9, item 7a).
//
// A member event with no displayname makes the SDK set rawDisplayName to the full user id
// (matrix-js-sdk room-member.ts), so a banned bridge puppet showed as the raw
// "@discord_<id>:<server>" and, unbroken, widened the page at 390 px. An id-shaped name is no
// name: the slot shows the localpart, as it does for a member with no name at all.
// Run: node --test app/lib/matrixDisplay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";
import type { RoomMember } from "matrix-js-sdk";

const { memberName, getMemberDisplayName } = await import("./matrixDisplay.ts");

const ID = "@discord_116465105724323:site.test";
const member = (rawDisplayName: string) => ({ userId: ID, rawDisplayName }) as unknown as RoomMember;

test("rawDisplayName equal to the user id → localpart", () => {
  assert.equal(memberName(member(ID), ID), "discord_116465105724323");
});

test("a name shaped like a Matrix id → localpart", () => {
  // Someone else's id as a display name reads as that person; it is not shown.
  assert.equal(memberName(member("@casey:other.test"), ID), "discord_116465105724323");
  assert.equal(memberName(member("@casey:other.test:8448"), ID), "discord_116465105724323");
});

test("a real name is kept, including one that only starts with @ or holds a colon", () => {
  assert.equal(memberName(member("Casey"), ID), "Casey");
  assert.equal(memberName(member("@casey"), ID), "@casey");
  assert.equal(memberName(member("re: casey"), ID), "re: casey");
});

test("no member, or an empty name → localpart; bidi controls still go", () => {
  assert.equal(memberName(null, ID), "discord_116465105724323");
  assert.equal(memberName(member(""), ID), "discord_116465105724323");
  assert.equal(memberName(member("Casey‮"), ID), "Casey");
  // An id hidden behind a bidi override is still an id.
  assert.equal(memberName(member(`‮${ID}`), ID), "discord_116465105724323");
});

test("getMemberDisplayName reads the room's member through the same rule", () => {
  const room = { getMember: () => member(ID) } as unknown as Parameters<typeof getMemberDisplayName>[0];
  assert.equal(getMemberDisplayName(room, ID), "discord_116465105724323");
});
