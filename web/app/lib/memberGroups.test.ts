// Categories, order and the fold for the members list, on plain
// member views — no SDK, no React.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberGroups.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { groupMembers, type MemberView, type MemberLadder } from "./memberGroups.ts";
import type { RoleRow } from "./community/desired.ts";

const mv = (over: Partial<MemberView>): MemberView => ({
  userId: "@u:site.test", label: "u", powerLevel: 0, fromDiscord: false, supporter: false, state: "offline", inactive: false, ...over,
});

// The default ladder as the server sends it (desired.ts DEFAULT_ROLES).
const role = (key: string, label: string, level: number, over: Partial<RoleRow> = {}): RoleRow =>
  ({ key, label, level, colour: null, hoist: key !== "member" && key !== "timeout", orderKey: "a0", builtin: true, ...over });
const ROLES: RoleRow[] = [
  role("admin", "Admin", 100), role("staff", "Staff", 75), role("mod", "Mod", 50), role("bot", "Bot", 50),
  role("supporter", "Supporter", 10), role("member", "Member", 0), role("timeout", "Timed out", -1),
];
const ladder = (over: Partial<MemberLadder> = {}): MemberLadder => ({ roles: ROLES, staffIds: [], botIds: [], hiddenIds: [], ...over });

// The category of a single member, read through the public grouping.
const categorize = (m: MemberView, l?: MemberLadder) => groupMembers([m], l).groups[0]?.key;

test("a member lands in the FIRST category that fits: power, then supporter, then members, ghosts last", () => {
  assert.equal(categorize(mv({ powerLevel: 100 })), "streamer");
  assert.equal(categorize(mv({ powerLevel: 50, supporter: true })), "mods", "a supporter who moderates is a Mod");
  assert.equal(categorize(mv({ supporter: true })), "supporters");
  assert.equal(categorize(mv({})), "members");
  assert.equal(categorize(mv({ fromDiscord: true })), "discord");
  assert.equal(categorize(mv({ fromDiscord: true, powerLevel: 50 })), "mods", "power level wins over the bridge");
  assert.equal(categorize(mv({ fromDiscord: true, powerLevel: 100 })), "streamer");
  assert.equal(categorize(mv({ fromDiscord: true, supporter: true })), "discord", "a ghost is never a Supporter — the bridge check runs before the supporter check");
});

test("staff before mods", () => {
  const { groups } = groupMembers([
    mv({ userId: "@mod:x", label: "a-mod", powerLevel: 50 }),
    mv({ userId: "@staff:x", label: "z-staff", powerLevel: 50 }),
    mv({ userId: "@high:x", label: "high", powerLevel: 75 }),
  ], ladder({ staffIds: ["@staff:x"] }));
  assert.deepEqual(groups.map((g) => [g.key, g.members.map((m) => m.userId)]), [
    ["staff", ["@high:x", "@staff:x"]],
    ["mods", ["@mod:x"]],
  ], "the site's Staff role puts a person on the Staff rung whatever their room power; 75 in the room is Staff too");
  assert.deepEqual(groups.map((g) => g.label), ["Staff", "Mods"]);
});

test("bot group", () => {
  const { groups } = groupMembers([
    mv({ userId: "@bot:x", label: "bot", powerLevel: 50 }),
    mv({ userId: "@mod:x", label: "mod", powerLevel: 50 }),
    mv({ userId: "@bigbot:x", label: "bigbot", powerLevel: 100 }),
  ], ladder({ botIds: ["@bot:x", "@bigbot:x"] }));
  assert.deepEqual(groups.map((g) => [g.key, g.members.map((m) => m.userId)]), [
    ["mods", ["@mod:x"]],
    ["bots", ["@bigbot:x", "@bot:x"]],
  ], "a bot is a Bot at mod level and above — never a Mod, never the Streamer");
  assert.deepEqual(groups.map((g) => g.label), ["Mods", "Bots"]);
});

test("hidden ids absent", () => {
  const hidden = ["@service:x", "@forum-reader:x"];
  const { groups, inactive } = groupMembers([
    mv({ userId: "@service:x", label: "service", powerLevel: 100 }),
    mv({ userId: "@forum-reader:x", label: "reader", inactive: true }),
    mv({ userId: "@streamer:x", label: "streamer", powerLevel: 100 }),
  ], ladder({ hiddenIds: hidden }));
  const shown = [...groups.flatMap((g) => g.members), ...inactive].map((m) => m.userId);
  assert.deepEqual(shown, ["@streamer:x"], "the service account and the forum reader appear nowhere, not even under Inactive");
  assert.deepEqual(groups.map((g) => [g.key, g.label]), [["streamer", "Streamer"]], "the streamer is shown as Streamer; nothing reads Creator");
});

test("badges follow the member's rung, in plain words — not the raw power level", () => {
  const { badges } = groupMembers([
    mv({ userId: "@streamer:x", powerLevel: 100 }),
    mv({ userId: "@staff75:x", powerLevel: 75 }),
    mv({ userId: "@staffrole:x", powerLevel: 0 }),
    mv({ userId: "@mod:x", powerLevel: 50 }),
    mv({ userId: "@bot:x", powerLevel: 50 }),
    mv({ userId: "@bigbot:x", powerLevel: 100 }),
    mv({ userId: "@idle-mod:x", powerLevel: 50, inactive: true }),
    mv({ userId: "@mem:x" }),
  ], ladder({ staffIds: ["@staffrole:x"], botIds: ["@bot:x", "@bigbot:x"] }));
  assert.deepEqual(Object.fromEntries([...badges].map(([id, b]) => [id, b.label])), {
    "@streamer:x": "Streamer", "@staff75:x": "Staff", "@staffrole:x": "Staff", "@mod:x": "Mod",
    "@bot:x": "Bot", "@bigbot:x": "Bot", "@idle-mod:x": "Mod",
  }, "a bot at 100 is a Bot, a Staff member at 75 is Staff; members carry no badge; a folded member keeps theirs");
});

test("a badge keeps its rung when the role is not hoisted, and a renamed role shows its name", () => {
  const roles = ROLES.map((r) => (r.key === "mod" ? { ...r, label: "Guardian", hoist: false } : r));
  const { groups, badges } = groupMembers([mv({ userId: "@mod:x", powerLevel: 50 })], ladder({ roles }));
  assert.deepEqual(groups.map((g) => g.key), ["members"]);
  assert.deepEqual(badges.get("@mod:x"), { rung: "mods", label: "Guardian" });
});

test("groups come in the fixed order with labels, and empty groups are omitted", () => {
  const { groups } = groupMembers([mv({ userId: "@a:x", label: "a" }), mv({ userId: "@b:x", label: "b", powerLevel: 100 })]);
  assert.deepEqual(groups.map((g) => g.key), ["streamer", "members"]);
  assert.deepEqual(groups.map((g) => g.label), ["Streamer", "Members"]);
});

test("all categories at once keep the fixed order: streamer, staff, mods, bots, supporters, members, discord", () => {
  const { groups } = groupMembers([
    mv({ userId: "@admin:x", label: "admin", powerLevel: 100 }),
    mv({ userId: "@staff:x", label: "staff", powerLevel: 75 }),
    mv({ userId: "@mod:x", label: "mod", powerLevel: 50 }),
    mv({ userId: "@modsup:x", label: "modsup", powerLevel: 50, supporter: true }),
    mv({ userId: "@bot:x", label: "bot", powerLevel: 50 }),
    mv({ userId: "@sup:x", label: "sup", supporter: true }),
    mv({ userId: "@mem:x", label: "mem" }),
    mv({ userId: "@ghost:x", label: "ghost", fromDiscord: true }),
  ], ladder({ botIds: ["@bot:x"] }));
  assert.deepEqual(groups.map((g) => g.key), ["streamer", "staff", "mods", "bots", "supporters", "members", "discord"]);
  assert.deepEqual(groups.map((g) => g.label), ["Streamer", "Staff", "Mods", "Bots", "Supporters", "Members", "Discord"]);
});

test("the ladder decides: a renamed role is shown by its name, its colour travels, and a role not hoisted joins Members", () => {
  const roles = ROLES.map((r) =>
    r.key === "mod" ? { ...r, label: "Guardians", colour: "#3366ff" } : r.key === "supporter" ? { ...r, hoist: false } : r);
  const { groups } = groupMembers([
    mv({ userId: "@mod:x", label: "mod", powerLevel: 50 }),
    mv({ userId: "@sup:x", label: "sup", supporter: true }),
    mv({ userId: "@mem:x", label: "mem" }),
  ], ladder({ roles }));
  assert.deepEqual(groups.map((g) => [g.key, g.label, g.colour]), [["mods", "Guardians", "#3366ff"], ["members", "Members", null]]);
  assert.deepEqual(groups[1]?.members.map((m) => m.userId), ["@mem:x", "@sup:x"], "a supporter whose role is not hoisted is listed with Members");
});

test("the ladder's own levels decide the rungs (a streamer who moves Mod to 40 sees 40 as a Mod)", () => {
  const roles = ROLES.map((r) => (r.key === "mod" ? { ...r, level: 40 } : r));
  assert.equal(categorize(mv({ powerLevel: 40 }), ladder({ roles })), "mods");
  assert.equal(categorize(mv({ powerLevel: 40 })), "members", "the default ladder: 40 is below Mod");
});

test("an older server's answer (no ladder fields) groups by the default ladder", () => {
  const { groups } = groupMembers([mv({ userId: "@m:x", label: "m", powerLevel: 50 }), mv({ userId: "@s:x", label: "s", powerLevel: 75 })],
    { roles: [], staffIds: [], botIds: [], hiddenIds: [] });
  assert.deepEqual(groups.map((g) => [g.key, g.label]), [["staff", "Staff"], ["mods", "Mods"]]);
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
