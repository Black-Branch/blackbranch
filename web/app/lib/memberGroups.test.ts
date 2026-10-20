// Categories, order and the fold for the members list, on plain
// member views — no SDK, no React.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberGroups.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupMembers, type MemberView } from "./memberGroups.ts";

const mv = (over: Partial<MemberView>): MemberView => ({
  userId: "@u:site.test", label: "u", powerLevel: 0, fromDiscord: false, supporter: false, state: "offline", inactive: false, ...over,
});

// The category of a single member, read through the public grouping.
const categorize = (m: MemberView) => groupMembers([m]).groups[0]?.key;

test("a member lands in the FIRST category that fits: power, then supporter, then members, ghosts last", () => {
  assert.equal(categorize(mv({ powerLevel: 100 })), "admin");
  assert.equal(categorize(mv({ powerLevel: 50, supporter: true })), "mods", "a supporter who moderates is a Moderator");
  assert.equal(categorize(mv({ supporter: true })), "supporters");
  assert.equal(categorize(mv({})), "members");
  assert.equal(categorize(mv({ fromDiscord: true })), "discord");
  assert.equal(categorize(mv({ fromDiscord: true, powerLevel: 50 })), "mods", "power level wins over the bridge — a bridged admin is an Admin");
  assert.equal(categorize(mv({ fromDiscord: true, powerLevel: 100 })), "admin");
  assert.equal(categorize(mv({ fromDiscord: true, supporter: true })), "discord", "a ghost is never a Supporter — the bridge check runs before the supporter check");
});

test("groups come in the fixed order with labels, and empty groups are omitted", () => {
  const { groups } = groupMembers([mv({ userId: "@a:x", label: "a" }), mv({ userId: "@b:x", label: "b", powerLevel: 100 })]);
  assert.deepEqual(groups.map((g) => g.key), ["admin", "members"]);
  assert.deepEqual(groups.map((g) => g.label), ["Admin", "Members"]);
});

test("all five categories at once keep the fixed order: admin, mods, supporters, members, discord", () => {
  const { groups } = groupMembers([
    mv({ userId: "@admin:x", label: "admin", powerLevel: 100 }),
    mv({ userId: "@mod:x", label: "mod", powerLevel: 50 }),
    mv({ userId: "@modsup:x", label: "modsup", powerLevel: 50, supporter: true }),
    mv({ userId: "@sup:x", label: "sup", supporter: true }),
    mv({ userId: "@mem:x", label: "mem" }),
    mv({ userId: "@ghost:x", label: "ghost", fromDiscord: true }),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ["admin", "mods", "supporters", "members", "discord"]);
  assert.deepEqual(groups.map((g) => g.label), ["Admin", "Moderators", "Supporters", "Members", "Discord"]);
});

test("inside a category: live first (community = site), then elsewhere, then away/dnd, then offline; alphabetical within", () => {
  const { groups } = groupMembers([
    mv({ userId: "@z:x", label: "zed", state: "offline" }),
    mv({ userId: "@y:x", label: "yara", state: "away" }),
    mv({ userId: "@d:x", label: "dan", state: "dnd" }),
    mv({ userId: "@e:x", label: "eve", state: "elsewhere" }),
    mv({ userId: "@c:x", label: "cleo", state: "community" }),
    mv({ userId: "@b:x", label: "bo", state: "site" }),
    mv({ userId: "@a:x", label: "Al", state: "offline" }),
  ]);
  assert.deepEqual(groups[0]?.members.map((m) => m.label), ["bo", "cleo", "eve", "dan", "yara", "Al", "zed"]);
});

test("the fold: inactive members leave their category for one alphabetical Inactive list — Discord ghosts NEVER fold", () => {
  const { groups, inactive } = groupMembers([
    mv({ userId: "@a:x", label: "a", inactive: true }),
    mv({ userId: "@m:x", label: "m", powerLevel: 50, inactive: true }),
    mv({ userId: "@g:x", label: "ghost", fromDiscord: true, inactive: true }),
    mv({ userId: "@b:x", label: "b" }),
  ]);
  assert.deepEqual(inactive.map((m) => m.label), ["a", "m"]);
  assert.deepEqual(groups.map((g) => [g.key, g.members.map((m) => m.label)]), [["members", ["b"]], ["discord", ["ghost"]]]);
});

test("sorting is by label, case-insensitively (localeCompare)", () => {
  const { groups } = groupMembers([mv({ userId: "@1:x", label: "bob" }), mv({ userId: "@2:x", label: "Alice" })]);
  assert.deepEqual(groups[0]?.members.map((m) => m.label), ["Alice", "bob"]);
});
