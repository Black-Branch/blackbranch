// The community reconciler's pure core (install/matrix/reconcile-core.mjs): desired state (the web's
// DesiredFeed) against what the homeserver holds → a list of operations. No I/O: these tests feed it
// fixtures and read the plan. The fixture pair (fixtures/community/feed.json + actual.json) is a
// community whose homeserver already matches the panel, so every test changes one thing and reads
// what the plan does about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  planSpaces, planRooms, planPower, planMembership, planAll, describe, pendingRef,
} from "./matrix/reconcile-core.mjs";
import { bundleShaped, ownerShaped } from "./fixtures/community/shapes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/community", f), "utf8"));
const S = "example.test";
const id = (x) => `!${x}:${S}`;
const u = (x) => `@${x}:${S}`;
const fresh = () => ({ desired: load("feed.json"), actual: load("actual.json") });
const roomRow = (d, name) => d.rooms.find((r) => r.name === name);
const apply = (d, a) => planAll(d, a, { mode: "apply" });
const opsFor = (ops, roomId) => ops.filter((o) => o.roomId === roomId);
const kinds = (ops) => ops.map((o) => o.op);
const powerFor = (ops, roomId) => ops.find((o) => o.op === "setPowerLevels" && o.roomId === roomId)?.content;
// Wipe one room's power levels in `actual` so planPower writes it out in full.
const forgetPower = (a, ...names) => { for (const n of names) a.rooms[id(n)].powerLevels = {}; };

test("vacuity: the fixtures are the community these tests describe", () => {
  const { desired, actual } = fresh();
  assert.equal(desired.rooms.length, 6);
  assert.equal(Object.keys(actual.rooms).length, 9);
  assert.deepEqual(desired.rooms.map((r) => r.see), ["everyone", "everyone", "supporters", "mods", "invited", "staff"]);
});

test("plan_is_empty_when_actual_matches", () => {
  const { desired, actual } = fresh();
  for (const mode of ["report", "apply"]) {
    const plan = planAll(desired, actual, { mode });
    assert.deepEqual(plan.ops, [], `${mode}: ${JSON.stringify(plan.ops.map(describe))}`);
    assert.deepEqual(plan.drift, [], `${mode}: ${JSON.stringify(plan.drift.map(describe))}`);
  }
  // Each planner, alone, agrees.
  for (const f of [planSpaces, planRooms, planPower, planMembership]) assert.deepEqual(f(desired, actual), [], f.name);
  // Maps (what reconcile.mjs builds) and plain objects (JSON fixtures) are the same input.
  const asMaps = {
    hub: actual.hub,
    rooms: new Map(Object.entries(actual.rooms).map(([k, v]) => [k, { ...v, members: new Map(Object.entries(v.members)) }])),
  };
  assert.deepEqual(apply(desired, asMaps).ops, []);
});

test("plan_creates_missing_room", () => {
  const { desired, actual } = fresh();
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", topic: null, orderKey: "a6", retentionDays: null, matrixRoomId: null });
  const { ops } = apply(desired, actual);
  const ref = pendingRef("rooms", 7);
  const create = ops.find((o) => o.op === "createRoom");
  assert.ok(create, "a createRoom op");
  assert.equal(create.ref, ref); assert.deepEqual(create.row, { table: "rooms", id: 7 }); assert.equal(create.roomId, null);
  const b = create.body;
  assert.equal(b.room_version, "12");
  assert.equal(b.preset, undefined, "never a preset");
  assert.equal(b.visibility, "private", "listing is its own publish op");
  assert.equal(b.name, "clips");
  assert.deepEqual(b.creation_content, {});
  const st = (type) => b.initial_state.find((s) => s.type === type)?.content;
  assert.deepEqual(st("m.room.guest_access"), { guest_access: "forbidden" });
  assert.deepEqual(st("m.room.join_rules"), { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: id("hub") }] });
  assert.deepEqual(st("m.room.history_visibility"), { history_visibility: "shared" });
  assert.deepEqual(st("m.space.parent"), undefined, "the link is linkChild's, written after the create");
  assert.equal(st("m.room.encryption"), undefined, "not encrypted unless the row says so");
  assert.equal(b.power_level_content_override.events_default, 0);
  assert.equal(b.power_level_content_override.users[u("community")], undefined);
  // Then it is linked into its category with its order, and listed (the row is published) — by ref.
  const link = ops.find((o) => o.op === "linkChild" && o.childId === ref);
  assert.deepEqual({ parentId: link.parentId, content: link.content }, { parentId: id("talk"), content: { via: [S], order: "a6" } });
  assert.deepEqual(link.childParent, { via: [S], canonical: true });
  assert.ok(ops.some((o) => o.op === "publish" && o.roomId === ref && o.visibility === "public"));
  // Creates come before anything that names their ref.
  const first = ops.findIndex((o) => o.ref === ref || o.roomId === ref || o.childId === ref);
  assert.equal(ops[first], create);
  // planPower does not re-write what createRoom already set.
  assert.ok(!ops.some((o) => o.op === "setPowerLevels" && o.roomId === ref));
  // An encrypted row is encrypted in the create, once, with Matrix's recommended rotation.
  desired.rooms.at(-1).encrypted = true; desired.rooms.at(-1).retentionDays = 400; desired.rooms.at(-1).kind = "forum";
  const b2 = apply(desired, actual).ops.find((o) => o.op === "createRoom").body;
  assert.deepEqual(b2.initial_state.find((s) => s.type === "m.room.encryption").content,
    { algorithm: "m.megolm.v1.aes-sha2", rotation_period_ms: 604800000, rotation_period_msgs: 100 });
  // Retention is capped at the install's cap (365 days in the fixture).
  assert.deepEqual(b2.initial_state.find((s) => s.type === "m.room.retention").content, { max_lifetime: 365 * 86400000 });
  // A forum carries the product's forum flag.
  assert.deepEqual(b2.initial_state.find((s) => s.type === "app.blackbranch.room_type").content, { type: "forum" });
});

test("plan_creates_missing_space_and_gate", () => {
  const { desired, actual } = fresh();
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "a2", matrixRoomId: null, gateTier: null });
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, spaceId: 4, name: "chess", topic: null, retentionDays: null, matrixRoomId: null });
  const { ops } = apply(desired, actual);
  const space = ops.find((o) => o.op === "createSpace");
  assert.equal(space.ref, pendingRef("spaces", 4));
  assert.deepEqual(space.body.creation_content, { type: "m.space", "app.blackbranch.space_kind": "category" });
  assert.equal(space.body.room_version, "12"); assert.equal(space.body.preset, undefined);
  assert.ok(kinds(ops).indexOf("createSpace") < kinds(ops).indexOf("createRoom"), "spaces first: rooms link into them");
  assert.ok(ops.some((o) => o.op === "linkChild" && o.parentId === id("hub") && o.childId === space.ref && o.content.order === "a2"));
  assert.ok(ops.some((o) => o.op === "linkChild" && o.parentId === space.ref && o.childId === pendingRef("rooms", 7)));
  // A gate space is invite-only and never linked into the hub (it is hidden).
  const d2 = fresh().desired, a2 = fresh().actual;
  delete a2.rooms[id("gate")]; d2.spaces[2].matrixRoomId = null;
  const ops2 = apply(d2, a2).ops;
  const gate = ops2.find((o) => o.op === "createSpace");
  assert.deepEqual(gate.body.initial_state.find((s) => s.type === "m.room.join_rules").content, { join_rule: "invite" });
  assert.ok(!ops2.some((o) => o.op === "linkChild" && o.childId === gate.ref));
  // The gated room's join rule names the gate-to-be by its ref.
  assert.deepEqual(ops2.find((o) => o.op === "setJoinRule" && o.roomId === id("lounge")).content,
    { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: gate.ref }] });
});

test("plan_sets_order_strings_from_order_keys", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "general").orderKey = "a2V";
  roomRow(desired, "news").orderKey = "Zz";
  const ops = planSpaces(desired, actual);
  const orders = ops.filter((o) => o.op === "setOrder").map((o) => [o.childId, o.content.order]);
  assert.deepEqual(orders, [[id("general"), "a2V"], [id("news"), "Zz"]]);
  for (const o of ops.filter((x) => x.op === "setOrder")) {
    assert.equal(o.parentId, id("talk")); assert.deepEqual(o.content.via, [S]);
  }
  // A category's own order is its row's key too.
  desired.spaces[1].orderKey = "a0x";
  assert.deepEqual(planSpaces(desired, actual).filter((o) => o.op === "setOrder" && o.childId === id("talk")).map((o) => o.content.order), ["a0x"]);
  // A link with no via is a missing link, written with the order.
  actual.rooms[id("talk")].children[0].via = [];
  const relink = planSpaces(fresh().desired, actual).find((o) => o.childId === id("general"));
  assert.equal(relink.op, "linkChild"); assert.equal(relink.content.order, "a0");
});

test("power_levels_never_list_the_creator", () => {
  const { desired, actual } = fresh();
  // A room the service account made: it is never listed, even when the feed names it (it should not).
  desired.people.push({ userId: u("community"), level: 100 });
  forgetPower(actual, "general");
  const ops = planPower(desired, actual);
  assert.equal(powerFor(ops, id("general")).users[u("community")], undefined);
  assert.equal(powerFor(ops, id("general")).users[u("streamer")], 100);
  // The same holds for a room the plan creates.
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", matrixRoomId: null });
  const c = apply(desired, fresh().actual).ops.find((o) => o.op === "createRoom");
  assert.equal(c.body.power_level_content_override.users[u("community")], undefined);
});

test("service_keeps_its_level_in_rooms_it_did_not_create", () => {
  // #mods was made by the streamer; the service account holds 100 there by a grant in `users`.
  // Dropping that entry would demote it to 0 on the first write and end every later run.
  const { desired, actual } = fresh();
  const m = actual.rooms[id("mods")];
  m.creators = [u("streamer")];
  m.powerLevels = { ...m.powerLevels, users: { [u("community")]: 100, [u("moddy")]: 50 } };
  const content = powerFor(planPower(desired, actual), id("mods"));
  assert.ok(content, "the ladder is written");
  assert.equal(content.users[u("community")], 100, "the service account keeps its own grant");
  assert.equal(content.users[u("streamer")], undefined, "a v12 creator cannot be listed");
  assert.equal(content.users[u("staffer")], 75);
  // Even when the feed names it lower, or times it out: its own entry is never lowered.
  desired.people.push({ userId: u("community"), level: 50 });
  desired.timedOut.push({ userId: u("community"), until: "2026-10-24T00:00:00.000Z" });
  assert.equal(powerFor(planPower(desired, actual), id("mods")).users[u("community")], 100);
  // The hub (the streamer's, the service granted 100 there) with a timeout: the service stays.
  const d2 = fresh().desired, a2 = fresh().actual;
  a2.rooms[id("hub")].powerLevels = { ...a2.rooms[id("hub")].powerLevels, users: { [u("community")]: 100 } };
  d2.timedOut.push({ userId: u("viewer1"), until: "2026-10-24T00:00:00.000Z" });
  const hub = powerFor(planPower(d2, a2), id("hub"));
  assert.deepEqual(hub.users, { [u("community")]: 100, [u("tim")]: -1, [u("viewer1")]: -1 });
  // Archive and unarchive keep it too.
  roomRow(desired, "mods").archived = true;
  const arch = apply(desired, actual).ops.find((o) => o.op === "archive" && o.roomId === id("mods"));
  assert.equal(arch.content.users[u("community")], 100);
});

test("power_write_never_exceeds_own_level: grants at or above the service are kept and said", () => {
  // Matrix refuses a change to anyone who holds as much as the sender, and any level set above it:
  // writing one would fail the room's whole write. They are kept as found, and the run says who.
  const { desired, actual } = fresh();
  const m = actual.rooms[id("mods")];
  m.creators = [u("streamer")];
  m.powerLevels = {
    ...m.powerLevels,
    events: { ...m.powerLevels.events, "m.room.tombstone": 100, "m.room.name": 50 },
    users: { [u("community")]: 100, [u("oldadmin")]: 100, [u("moddy")]: 50 },
  };
  const ops = planPower(desired, actual);
  const content = powerFor(ops, id("mods"));
  assert.equal(content.users[u("oldadmin")], 100, "a hand-granted 100 the ladder does not hold stays");
  assert.equal(content.events["m.room.tombstone"], 100, "150 is above the service's own 100: left as it is");
  assert.equal(content.events["m.room.name"], 75, "a level it may set is set");
  const w = ops.find((o) => o.op === "warn" && o.code === "grant_out_of_reach");
  assert.equal(w.roomId, id("mods"));
  assert.equal(describe(w), "a power grant in #mods is above what the community account can change; it was left as it is");
  assert.deepEqual(w.userIds, [u("oldadmin")]);
  assert.doesNotMatch(describe(w), /@/, "the sentence names the room, never the account");
  // Vacuity: in a room the service made, the same 100 is the ladder's to remove.
  const own = fresh();
  own.actual.rooms[id("mods")].powerLevels.users[u("oldadmin")] = 100;
  const c2 = powerFor(planPower(own.desired, own.actual), id("mods"));
  assert.equal(c2.users[u("oldadmin")], undefined);
  assert.equal(c2.events["m.room.tombstone"], 150);
});

test("bridge_accounts_keep_their_grants: a bot the site lists keeps its grant and seat", () => {
  // The site's Bridge accounts setting (the feed's bridgeBots) names the bot. The row is a plain one
  // (not Discord-linked): the bot keeps its grant and its seat.
  const { desired, actual } = fresh();
  const mods = actual.rooms[id("mods")];
  desired.bridgeBots = [u("bridgebot")];
  mods.members[u("bridgebot")] = "join";
  mods.members[u("mallory")] = "ban";
  mods.powerLevels = { ...mods.powerLevels, users: { ...mods.powerLevels.users, [u("bridgebot")]: 60 } };
  const { ops } = apply(desired, actual);
  assert.ok(!ops.some((o) => o.roomId === id("mods") && o.op === "setPowerLevels"), "its grant is kept: nothing to write");
  assert.ok(!ops.some((o) => o.op === "kick" && o.userId === u("bridgebot")), "never removed from a mods-only room");
  // A ban someone placed on it by hand is not reported as the site's business either.
  mods.members[u("bridgebot")] = "ban";
  assert.ok(!apply(desired, actual).drift.some((d) => d.kind === "ban" && d.userId === u("bridgebot")));
  // Vacuity: an account the site does not list is removed and loses the grant.
  desired.bridgeBots = [];
  mods.members[u("bridgebot")] = "join";
  const plain = apply(desired, actual);
  assert.ok(plain.ops.some((o) => o.op === "kick" && o.userId === u("bridgebot")));
  assert.equal(powerFor(plain.ops, id("mods")).users[u("bridgebot")], undefined);
});

test("mod_cannot_declare_itself_a_bridge_bot: someone the site knows gets the ladder, never a bridge's exemption", () => {
  // Even listed as a bridge account (by mistake, or after declaring itself in room state), someone on
  // the ladder gets the ladder; banned, the ban.
  const { desired, actual } = fresh();
  actual.rooms[id("mods")].bridgeHints = [u("staffer")];
  desired.bridgeBots = [u("staffer")];
  // The site makes them a mod: the ladder writes 50.
  desired.people = desired.people.map((p) => (p.userId === u("staffer") ? { ...p, level: 50 } : p));
  assert.equal(powerFor(apply(desired, actual).ops, id("mods")).users[u("staffer")], 50);
  // The site bans them: banned in the room like anyone, no grant kept.
  desired.people = desired.people.filter((p) => p.userId !== u("staffer"));
  desired.banned.push(u("staffer"));
  const { ops } = apply(desired, actual);
  assert.ok(ops.some((o) => o.op === "ban" && o.roomId === id("mods") && o.userId === u("staffer")));
  assert.equal(powerFor(ops, id("mods")).users[u("staffer")], undefined);
});

test("banned_bridge_id_is_still_banned: a site ban wins over a room's bridge state", () => {
  const { feed, actual } = ownerShaped();
  feed.banned.push(u("discordbot"));
  const { ops } = planAll(feed, actual, { mode: "apply" });
  assert.ok(ops.some((o) => o.op === "ban" && o.roomId === id("obridged") && o.userId === u("discordbot")));
  // It holds 100 like the service, so its level is out of reach (said), but nothing exempts it.
  assert.ok(ops.some((o) => o.code === "grant_out_of_reach" && o.roomId === id("obridged")));
});

test("listed_bridge_bot_keeps_grant: a bot under Bridge accounts keeps its grant and seat; its room's own hint says nothing more", () => {
  const { desired, actual } = fresh();
  const mods = actual.rooms[id("mods")];
  desired.bridgeBots = [u("bridgebot")];
  mods.bridgeHints = [u("bridgebot")];
  mods.members[u("bridgebot")] = "join";
  mods.powerLevels = { ...mods.powerLevels, users: { ...mods.powerLevels.users, [u("bridgebot")]: 60 } };
  const { ops } = apply(desired, actual);
  assert.ok(!ops.some((o) => o.roomId === id("mods") && (o.op === "setPowerLevels" || o.op === "kick")));
  assert.ok(!ops.some((o) => o.code === "bridge_account_unlisted"));
});

test("unlisted_bridge_bot_gets_no_exemption: a room's own bridge state grants nothing, and is said once", () => {
  // Anyone holding state power can write m.bridge naming themselves; only the site's setting counts.
  const { desired, actual } = fresh();
  const mods = actual.rooms[id("mods")];
  mods.bridgeHints = [u("selfmade")];
  mods.members[u("selfmade")] = "join";
  mods.powerLevels = { ...mods.powerLevels, users: { ...mods.powerLevels.users, [u("selfmade")]: 60 } };
  const { ops } = apply(desired, actual);
  assert.equal(powerFor(ops, id("mods")).users[u("selfmade")], undefined, "the ladder owns its grant");
  assert.ok(ops.some((o) => o.op === "kick" && o.roomId === id("mods") && o.userId === u("selfmade")), "removed like anyone not on the rung");
  const w = ops.filter((o) => o.code === "bridge_account_unlisted");
  assert.deepEqual(w.map((o) => o.roomId), [id("mods")]);
  assert.equal(describe(w[0]), "#mods looks bridged by @selfmade:example.test: add it under Bridge accounts if that is right");
});

test("bridged_room_keeps_only_bridge_grants: the bot, and a puppet below a mod; a stranger and a demoted person follow the ladder", () => {
  const { desired, actual } = fresh();
  desired.bridgeUserPatterns = ["@discord_[0-9]+:example\\.test"];
  const mods = actual.rooms[id("mods")];
  mods.creators = [u("streamer")];
  desired.bridgeBots = [u("bridgebot")];
  mods.powerLevels = { ...mods.powerLevels, users: { [u("community")]: 100, [u("bridgebot")]: 100, [u("stranger")]: 50,
    [u("discord_1")]: 10, [u("discord_2")]: 50, [u("moddy")]: 50 } };
  desired.people = desired.people.filter((p) => p.userId !== u("moddy")); // demoted on the site
  const ops = planPower(desired, actual);
  const users = powerFor(ops, id("mods")).users;
  assert.equal(users[u("bridgebot")], 100, "the bot keeps its grant");
  assert.equal(users[u("discord_1")], 10, "a puppet below a mod keeps its grant");
  assert.equal(users[u("discord_2")], undefined, "a puppet at a mod's level is dropped…");
  assert.match(describe(ops.find((o) => o.code === "bridge_grant_dropped")), /^@discord_2:example\.test is a bridge account in #mods with a moderator's power or more/);
  assert.equal(users[u("stranger")], undefined, "a stranger's hand grant follows the ladder");
  assert.equal(users[u("moddy")], undefined, "a demoted person follows the ladder");
  assert.equal(users[u("community")], 100);
});

test("bridged_room_without_patterns_follows_the_ladder: unknown grants are not kept, and no bridge warn", () => {
  const { desired, actual } = fresh();
  const mods = actual.rooms[id("mods")];
  desired.bridgeBots = [u("bridgebot")];
  mods.powerLevels = { ...mods.powerLevels, users: { ...mods.powerLevels.users, [u("bridgebot")]: 100, [u("stranger")]: 50, [u("discord_1")]: 10 } };
  const { ops } = apply(desired, actual);
  const users = powerFor(ops, id("mods")).users;
  assert.equal(users[u("bridgebot")], 100);
  assert.equal(users[u("stranger")], undefined);
  assert.equal(users[u("discord_1")], undefined, "without patterns no puppet can be told apart");
  assert.ok(!ops.some((o) => o.code === "bridge_accounts_unknown"), "the room has its listed bot: the bridge is known");
});

test("bridged_room_with_an_out_of_reach_grant: said once as grant_out_of_reach, never as a bridge gap, on every run alike", () => {
  // A listed bot, and a hand-granted 100 the service (not the creator, at 100) cannot change.
  const { desired, actual } = fresh();
  const mods = actual.rooms[id("mods")];
  mods.creators = [u("streamer")];
  desired.bridgeBots = [u("bridgebot")];
  mods.powerLevels = { ...mods.powerLevels, users: { [u("community")]: 100, [u("bridgebot")]: 100, [u("handadmin")]: 100, [u("moddy")]: 50 } };
  for (let run = 0; run < 2; run++) {
    const { ops } = apply(desired, actual);
    assert.ok(!ops.some((o) => o.code === "bridge_accounts_unknown"), `run ${run}`);
    const w = ops.filter((o) => o.code === "grant_out_of_reach" && o.roomId === id("mods"));
    assert.equal(w.length, 1, `run ${run}: once`);
    assert.match(describe(w[0]), /^a power grant in #mods is above what the community account can change; it was left as it is$/);
    const write = powerFor(ops, id("mods"));
    if (write) { assert.equal(write.users[u("handadmin")], 100, "and it was left"); mods.powerLevels = write; }
  }
});

test("bridge_accounts_unknown only for a Discord-linked row with no patterns (the bridge's accounts unknowable)", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "mods").discordChannelId = "100000000000000001";
  assert.equal(apply(desired, actual).ops.filter((o) => o.code === "bridge_accounts_unknown").length, 1);
  desired.bridgeUserPatterns = ["@discord_[0-9]+:example\\.test"];
  assert.equal(apply(desired, actual).ops.filter((o) => o.code === "bridge_accounts_unknown").length, 0);
});

test("put_back_off_writes_the_ladder_only", () => {
  // With put-back off, a demoted mod still loses their grant (moderation always applies), while a
  // hand-changed per-event level stays and is reported.
  const { desired, actual } = fresh();
  desired.putBack = false;
  desired.people = desired.people.filter((p) => p.userId !== u("moddy"));
  const g = actual.rooms[id("general")].powerLevels;
  g.events = { ...g.events, "m.room.topic": 0 };
  const { ops, drift } = apply(desired, actual);
  const written = powerFor(ops, id("general"));
  assert.equal(written.users[u("moddy")], undefined, "the ladder applied");
  assert.equal(written.events["m.room.topic"], 0, "the hand-made event level is kept in the write");
  const rules = drift.find((o) => o.op === "setPowerRules" && o.roomId === id("general"));
  assert.equal(rules.content.events["m.room.topic"], 75);
  assert.equal(describe(rules), "change what each rung may do in #general");
  // Only the ladder differs: one whole write, nothing in drift for the room.
  const d2 = fresh(); d2.desired.putBack = false; d2.desired.people = d2.desired.people.filter((p) => p.userId !== u("moddy"));
  const p2 = apply(d2.desired, d2.actual);
  assert.ok(powerFor(p2.ops, id("general")));
  assert.ok(!p2.drift.some((o) => o.op === "setPowerRules"));
});

test("a_missing_retention_event_always_applies", () => {
  // Nobody's edit made it missing, so the put-back switch does not hold it back; a changed value does.
  const { desired, actual } = fresh();
  desired.putBack = false;
  actual.rooms[id("news")].retention = undefined;
  actual.rooms[id("general")].retention = 7 * 86400000;
  const { ops, drift } = apply(desired, actual);
  assert.ok(ops.some((o) => o.op === "setRetention" && o.roomId === id("news")), "missing: written");
  assert.ok(!drift.some((o) => o.op === "setRetention" && o.roomId === id("news")));
  assert.ok(drift.some((o) => o.op === "setRetention" && o.roomId === id("general")), "changed by hand: drift");
});

test("bridge_accounts_unknown_once_per_room", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "mods").discordChannelId = "100000000000000001";
  const { ops } = apply(desired, actual);
  const w = ops.filter((o) => o.op === "warn" && o.code === "bridge_accounts_unknown");
  assert.deepEqual(w.map((o) => o.roomId), [id("mods")], "planPower and planMembership both find it; the run says it once");
});

test("no_hub_access_warns_and_writes_nothing: the hub has no row and cannot be read", () => {
  const { feed, actual } = bundleShaped();
  // Before the service account has joined: the command reads the hub as unreadable.
  const before = { hub: { roomId: feed.hubRoomId, children: [] }, rooms: { [feed.hubRoomId]: { unreadable: true, creators: [] } } };
  for (const mode of ["report", "apply"]) {
    const plan = planAll(feed, before, { mode });
    const w = [...plan.ops, ...plan.drift].filter((o) => o.code === "no_hub_access");
    assert.equal(w.length, 1, mode);
    assert.match(describe(w[0]), /cannot read the community's main space/);
    assert.deepEqual(plan.ops.filter((o) => o.op !== "warn"), [], `${mode}: nothing to write`);
  }
  assert.equal(planAll(feed, before, { mode: "adopt" }).drift.filter((o) => o.code === "no_hub_access").length, 1);
  // Readable, or a hub with a row: no such warn.
  assert.ok(!planAll(feed, actual, { mode: "report" }).drift.some((o) => o.code === "no_hub_access"));
  const f = fresh();
  delete f.actual.rooms[id("hub")];
  assert.ok(!planAll(f.desired, f.actual, { mode: "report" }).drift.some((o) => o.code === "no_hub_access"));
});

test("bundle_shaped: the streamer's hub, #general and #forum are imported, then kept without demoting the service", () => {
  const { feed, actual } = bundleShaped();
  const adopt = planAll(feed, actual, { mode: "adopt" });
  assert.deepEqual(adopt.ops.map((o) => [o.table, o.row.kind, o.matrixRoomId]),
    [["spaces", "hub", id("bhub")], ["rooms", "text", id("bgeneral")], ["rooms", "forum", id("bforum")]]);
  assert.equal(adopt.ops[1].row.retentionDays, 30);
  // The rows adopt makes (the site's /adopt route), then apply: the service keeps 100 everywhere.
  feed.spaces = [{ id: 1, parentId: null, ...adopt.ops[0].row }];
  feed.rooms = adopt.ops.slice(1).map((o, i) => ({ id: i + 1, spaceId: null, ...o.row }));
  for (const mode of ["report", "apply"]) {
    const plan = planAll(feed, actual, { mode });
    const all = [...plan.ops, ...plan.drift];
    for (const o of all.filter((x) => x.op === "setPowerLevels")) {
      assert.equal(o.content.users[u("community")], 100, `${mode}: ${o.label}`);
      assert.equal(o.content.users[u("streamer")], undefined, "the creator is never listed");
    }
    assert.ok(all.some((o) => o.op === "setPowerLevels"), "vacuity: the ladder is written somewhere");
    assert.ok(!all.some((o) => o.op === "kick"), "nobody removed");
  }
  // Applied once (the homeserver now as the plan wanted), a second plan writes nothing.
  const next = applyPower(actual, planAll(feed, actual, { mode: "apply" }).ops);
  assert.deepEqual(planAll(feed, next, { mode: "apply" }).ops.filter((o) => o.op === "setPowerLevels"), []);
});

test("bundle_shaped_first_apply_puts_nothing_back: the bootstrap's rooms, imported with the setup's channels, are already as the panel has them", () => {
  const { feed, actual } = bundleShaped();
  const adopt = planAll(feed, actual, { mode: "adopt" });
  // The site's /adopt route: the hub row with the setup's channels (keys from "a0", setupChannelRows),
  // then each room at its own order key when it is one of the panel's (adoptServer.ts placeAfter).
  feed.spaces = [{ id: 1, parentId: null, ...adopt.ops[0].row }];
  feed.rooms = [
    { id: 1, spaceId: 1, kind: "announcement", name: "announcements", topic: null, avatarMxc: null, orderKey: "a0", see: "everyone", post: "mods",
      retentionDays: 365, encrypted: false, published: true, archived: false, matrixRoomId: null, discordChannelId: null },
    ...adopt.ops.slice(1).map((o, i) => ({ id: i + 2, spaceId: 1, ...o.row, discordChannelId: null })),
  ];
  assert.deepEqual(feed.rooms.slice(1).map((r) => [r.name, r.orderKey]), [["general", "Zy"], ["forum", "Zz"]], "the bootstrap's places are kept");
  for (const mode of ["report", "apply"]) {
    const plan = planAll(feed, actual, { mode });
    const all = [...plan.ops, ...plan.drift];
    assert.deepEqual(all.filter((o) => o.putBack).map((o) => describe(o)), [], `${mode}: nothing is put back`);
    assert.ok(all.some((o) => o.op === "createRoom" && o.label === "#announcements"), `vacuity (${mode}): the setup's channel is made`);
    assert.ok(!all.some((o) => o.op === "setJoinRule" || o.op === "setOrder"), mode);
  }
});

test("adopt_order_is_deterministic: a space's children by order, then by when they were linked, then by room id", () => {
  // The homeserver lists a room's state in no fixed order; the import (and its orderKeys) must not care.
  const { feed, actual } = bundleShaped();
  const hub = actual.rooms[id("bhub")];
  const plain = (rid, extra = {}) => ({ roomId: id(rid), order: null, via: [S], ...extra });
  const names = (children) => {
    hub.children = children; actual.hub.children = children;
    for (const ch of children) actual.rooms[ch.roomId] ??= { ...structuredClone(actual.rooms[id("bgeneral")]), name: ch.roomId.slice(1, -S.length - 1) };
    return planAll(feed, actual, { mode: "adopt" }).ops.filter((o) => o.table === "rooms").map((o) => o.matrixRoomId);
  };
  // No order, equal times: by room id, whichever way they were listed.
  const want = [id("ra"), id("rb"), id("rc")];
  assert.deepEqual(names([plain("rc"), plain("ra"), plain("rb")]), want);
  assert.deepEqual(names([plain("rb"), plain("rc"), plain("ra")]), want);
  // No order: the earlier link first, before the room id.
  assert.deepEqual(names([plain("ra", { ts: 30 }), plain("rb", { ts: 10 }), plain("rc", { ts: 20 })]), [id("rb"), id("rc"), id("ra")]);
  // An order wins over time, and a child with one comes before every child without.
  assert.deepEqual(names([plain("ra", { ts: 1 }), plain("rb", { order: "b", ts: 9 }), plain("rc", { order: "a", ts: 9 })]), [id("rc"), id("rb"), id("ra")]);
});

test("owner_shaped: rooms the streamer made, a bridged room and a hand-granted 100, through report and apply", () => {
  const { feed, actual } = ownerShaped();
  const report = planAll(feed, actual, { mode: "report" });
  assert.deepEqual(report.ops, []);
  const { ops } = planAll(feed, actual, { mode: "apply" });
  assert.deepEqual(report.drift, ops, "report lists exactly what apply would do");
  const power = ops.filter((o) => o.op === "setPowerLevels");
  assert.ok(power.length >= 3, "vacuity: power is written");
  for (const o of power) {
    assert.equal(o.content.users[u("community")], 100, `the service keeps 100 in ${o.label}`);
    assert.equal(o.content.users[u("streamer")], undefined, `the creator is never listed in ${o.label}`);
    assert.equal(o.content.users[u("oldadmin")], 100, `a hand-granted 100 is out of reach in ${o.label}`);
    assert.ok(!o.content.events || o.content.events["m.room.tombstone"] === 100, `no level above the service's own in ${o.label}`);
  }
  // The hub: only the timeout.
  assert.deepEqual(power.find((o) => o.roomId === id("ohub")).content.users,
    { [u("community")]: 100, [u("moddy")]: 50, [u("oldadmin")]: 100, [u("tim")]: -1 });
  // The bridged room: the bot keeps its 100 and its seat, a puppet its 50; nobody is removed.
  const bridged = power.find((o) => o.roomId === id("obridged")).content;
  assert.equal(bridged.users[u("discordbot")], 100);
  assert.equal(bridged.users[u("discord_123")], undefined, "no patterns: a puppet cannot be told from a stranger");
  assert.ok(!ops.some((o) => o.code === "bridge_accounts_unknown"), "the bridge is listed: no bridge gap");
  assert.ok(!ops.some((o) => o.op === "kick"));
  // The hand-granted 100 is said once per room.
  const held = ops.filter((o) => o.code === "grant_out_of_reach");
  assert.deepEqual(held.map((o) => o.roomId).sort(), [id("obridged"), id("ogeneral"), id("omodchat")].sort());
  // Bans reach every room; no op names a level above 100.
  assert.equal(ops.filter((o) => o.op === "ban").length, 4);
  // Applied, a second plan writes no power.
  const next = applyPower(actual, ops);
  assert.deepEqual(planAll(feed, next, { mode: "apply" }).ops.filter((o) => o.op === "setPowerLevels"), []);
});

/** `actual` with every setPowerLevels in `ops` written, as the homeserver would hold it after apply. */
function applyPower(actual, ops) {
  const next = structuredClone(actual);
  for (const o of ops) if (o.op === "setPowerLevels") next.rooms[o.roomId].powerLevels = structuredClone(o.content);
  return next;
}

test("power_levels_events_default_from_post_rule", () => {
  const { desired, actual } = fresh();
  forgetPower(actual, "general", "news", "lounge", "mods", "vip", "staff");
  const ops = planPower(desired, actual);
  const ed = (n) => powerFor(ops, id(n)).events_default;
  assert.deepEqual([ed("general"), ed("lounge"), ed("news"), ed("staff")], [0, 10, 50, 75]);
  // The rest of the table is spec §4.2's: owner decisions at 100, channel edits at Staff, moderation at Mod.
  const c = powerFor(ops, id("general"));
  assert.equal(c.users_default, 0); assert.equal(c.state_default, 50);
  assert.deepEqual([c.ban, c.kick, c.redact, c.invite, c.notifications.room], [50, 50, 50, 50, 50]);
  for (const t of ["m.room.power_levels", "m.room.join_rules", "m.room.history_visibility", "m.room.encryption", "m.room.retention", "m.room.server_acl", "m.room.guest_access"]) assert.equal(c.events[t], 100, t);
  for (const t of ["m.room.name", "m.room.topic", "m.room.avatar", "m.room.canonical_alias", "m.space.child"]) assert.equal(c.events[t], 75, t);
  assert.equal(c.events["m.room.pinned_events"], 50);
  assert.equal(c.events["m.room.tombstone"], 150);
  // An announcement room: posting is for mods, reacting is for everyone (spec §4.3).
  assert.equal(powerFor(ops, id("news")).events["m.reaction"], 0);
  assert.equal(c.events["m.reaction"], undefined);
});

test("supporters_get_level_10_only_in_gated_rooms", () => {
  const { desired, actual } = fresh();
  forgetPower(actual, "general", "news", "lounge", "mods", "vip", "staff");
  const ops = planPower(desired, actual);
  assert.equal(powerFor(ops, id("lounge")).users[u("alice")], 10);
  for (const n of ["general", "news", "mods", "vip", "staff"]) assert.equal(powerFor(ops, id(n)).users[u("alice")], undefined, n);
  // A supporter who is also a mod keeps the higher level in a gated room.
  desired.supporters.push(u("moddy"));
  assert.equal(powerFor(planPower(desired, actual), id("lounge")).users[u("moddy")], 50);
  // A supporter-posting room that is NOT supporter-visible still gets the 10s (posting is what 10 is for).
  roomRow(desired, "general").post = "supporters";
  assert.equal(powerFor(planPower(desired, actual), id("general")).users[u("alice")], 10);
});

test("timed_out_get_minus_one_in_every_hub_room", () => {
  const { desired, actual } = fresh();
  forgetPower(actual, "general", "news", "lounge", "mods", "vip", "staff");
  // Timed out wins over every other level: a timed-out supporter and a timed-out mod.
  desired.timedOut.push({ userId: u("alice"), until: "2026-10-24T00:00:00.000Z" }, { userId: u("moddy"), until: "2026-10-24T00:00:00.000Z" });
  const ops = planPower(desired, actual);
  for (const n of ["general", "news", "lounge", "mods", "vip", "staff"]) {
    const users = powerFor(ops, id(n)).users;
    assert.equal(users[u("tim")], -1, n); assert.equal(users[u("alice")], -1, n); assert.equal(users[u("moddy")], -1, n);
  }
  // When the timeout ends, the entry goes (fixture actual has tim at -1 in every room).
  const d = fresh().desired; d.timedOut = [];
  const after = planPower(d, fresh().actual);
  // Six channels, the two spaces and the hub.
  assert.deepEqual(after.map((o) => o.roomId).sort(), [id("gate"), id("general"), id("hub"), id("lounge"), id("mods"), id("news"), id("staff"), id("talk"), id("vip")]);
  for (const o of after) assert.equal(o.content.users[u("tim")], undefined);
});

test("timed_out_is_minus_one_in_spaces_too", () => {
  // Task 1.3's fixed shape: a timed-out mod stays in `people` at 50 and is listed in `timedOut`.
  const { desired, actual } = fresh();
  desired.timedOut.push({ userId: u("moddy"), until: "2026-10-24T00:00:00.000Z" });
  const ops = planPower(desired, actual);
  for (const r of ["hub", "talk", "gate"]) assert.equal(powerFor(ops, id(r))?.users[u("moddy")], -1, r);
  // The hub keeps the bootstrap's own settings: only the timeout is applied there.
  assert.deepEqual(powerFor(ops, id("hub")), { ...actual.rooms[id("hub")].powerLevels, users: { [u("moddy")]: -1, [u("tim")]: -1 } });
  // A space this plan creates starts with the timeouts in it.
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "a2", matrixRoomId: null, gateTier: null });
  const space = apply(desired, actual).ops.find((o) => o.op === "createSpace");
  assert.equal(space.body.power_level_content_override.users[u("moddy")], -1);
  assert.equal(space.body.power_level_content_override.users[u("tim")], -1);
});

test("archive_content_keeps_timed_out_at_minus_one", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "news").archived = true;
  desired.timedOut.push({ userId: u("moddy"), until: "2026-10-24T00:00:00.000Z" });
  const archive = apply(desired, actual).ops.find((o) => o.op === "archive");
  assert.equal(archive.content.events_default, 100);
  assert.equal(archive.content.users[u("moddy")], -1);
  assert.equal(archive.content.users[u("tim")], -1);
  assert.equal(archive.content.users[u("streamer")], 100, "the rest is kept");
  // An archived room whose timeouts changed is written again, still archived; an ended timeout's −1 goes.
  actual.rooms[id("news")].powerLevels = archive.content;
  actual.rooms[id("talk")].children = actual.rooms[id("talk")].children.filter((ch) => ch.roomId !== id("news"));
  assert.deepEqual(opsFor(apply(desired, actual).ops, id("news")), []);
  desired.timedOut = [];
  const again = opsFor(apply(desired, actual).ops, id("news"));
  assert.deepEqual(kinds(again), ["archive"]);
  assert.equal(again[0].content.users[u("moddy")], undefined);
  assert.equal(again[0].content.users[u("tim")], undefined);
  assert.equal(again[0].content.events_default, 100);
  // Unarchive content is the full ladder, timeouts included.
  roomRow(desired, "news").archived = false;
  desired.timedOut = [{ userId: u("moddy"), until: "2026-10-24T00:00:00.000Z" }];
  assert.equal(apply(desired, actual).ops.find((o) => o.op === "unarchive").content.users[u("moddy")], -1);
});

test("members_never_written_at_level_0", () => {
  const { desired, actual } = fresh();
  forgetPower(actual, "general");
  desired.people.push({ userId: u("plain"), level: 0 });
  actual.rooms[id("general")].powerLevels = { users: { [u("bob")]: 0 } };
  const c = powerFor(planPower(desired, actual), id("general"));
  assert.ok(Object.keys(c.users).length >= 4, "vacuity: the ladder is there");
  assert.ok(Object.values(c.users).every((v) => v !== 0), JSON.stringify(c.users));
  assert.equal(c.users[u("bob")], undefined); assert.equal(c.users[u("plain")], undefined);
});

test("mods_and_staff_rooms_invite_the_rung_and_above", () => {
  const { desired, actual } = fresh();
  // Controller ruling: "Mods and above" is everyone at 50 or more in `people`, bots included —
  // the ladder cannot tell a bot from a mod, and a bot is at 50 by design (botty is the bot here).
  actual.rooms[id("mods")].members = { [u("community")]: "join", [u("streamer")]: "join", [u("bob")]: "join", [u("mallory")]: "ban" };
  actual.rooms[id("staff")].members = { [u("community")]: "join", [u("mallory")]: "ban" };
  const ops = planMembership(desired, actual);
  const inv = (r) => ops.filter((o) => o.op === "invite" && o.roomId === id(r)).map((o) => o.userId).sort();
  const kick = (r) => ops.filter((o) => o.op === "kick" && o.roomId === id(r)).map((o) => o.userId).sort();
  assert.deepEqual(inv("mods"), [u("botty"), u("moddy"), u("staffer")]);
  assert.deepEqual(kick("mods"), [u("bob")], "a member below the rung is removed");
  assert.deepEqual(inv("staff"), [u("staffer"), u("streamer")]);
  // Losing the rung: moddy stops being a mod → removed from the mods room; staffer drops to mod →
  // removed from the staff room, kept in the mods room.
  const d = fresh().desired;
  d.people = d.people.filter((p) => p.userId !== u("moddy"));
  d.people.find((p) => p.userId === u("staffer")).level = 50;
  const ops2 = planMembership(d, fresh().actual);
  assert.deepEqual(ops2.filter((o) => o.op === "kick").map((o) => [o.roomId, o.userId]).sort(),
    [[id("gate"), u("moddy")], [id("lounge"), u("moddy")], [id("mods"), u("moddy")], [id("staff"), u("staffer")]]);
  assert.ok(ops2.filter((o) => o.op === "kick").every((o) => typeof o.reason === "string" && o.reason.length > 0));
  // The hidden accounts (service account, forum reader) and a room's creators are never removed.
  const a3 = fresh().actual;
  a3.rooms[id("staff")].members[u("reader")] = "join";
  a3.rooms[id("staff")].creators = [u("community"), u("someone")]; a3.rooms[id("staff")].members[u("someone")] = "join";
  assert.deepEqual(planMembership(fresh().desired, a3).filter((o) => o.op === "kick"), []);
});

test("invited_rooms_are_left_alone", () => {
  const { desired, actual } = fresh();
  actual.rooms[id("vip")].members[u("dave")] = "join";
  delete actual.rooms[id("vip")].members[u("streamer")];
  const ops = opsFor(planMembership(desired, actual), id("vip"));
  assert.deepEqual(ops.filter((o) => o.op === "invite" || o.op === "kick"), []);
  // …but a site ban still reaches it (bans are every hub room's).
  delete actual.rooms[id("vip")].members[u("mallory")];
  assert.deepEqual(kinds(opsFor(planMembership(desired, actual), id("vip"))), ["ban"]);
});

test("supporters_are_invited_to_the_gate_and_gated_rooms", () => {
  const { desired, actual } = fresh();
  desired.supporters.push(u("sue"));
  const ops = planMembership(desired, actual);
  assert.deepEqual(ops.filter((o) => o.op === "invite").map((o) => [o.roomId, o.userId]).sort(),
    [[id("gate"), u("sue")], [id("lounge"), u("sue")]]);
  // Lapsed (the feed no longer lists them: the grace is the entitlement predicate's) → removed from both.
  const d = fresh().desired; d.supporters = [];
  const ops2 = planMembership(d, fresh().actual);
  assert.deepEqual(ops2.filter((o) => o.op === "kick").map((o) => [o.roomId, o.userId]).sort(),
    [[id("gate"), u("alice")], [id("lounge"), u("alice")]]);
  // A pending invite counts as in (no second invite); a banned supporter is never invited.
  actual.rooms[id("gate")].members[u("sue")] = "invite";
  desired.banned.push(u("sue"));
  assert.ok(!planMembership(desired, actual).some((o) => o.op === "invite" && o.userId === u("sue")));
});

test("banned_are_banned_in_every_hub_room_and_unbanned_when_lifted", () => {
  const { desired, actual } = fresh();
  desired.banned.push(u("eve"));
  actual.rooms[id("general")].members[u("eve")] = "join";
  const bans = planMembership(desired, actual).filter((o) => o.op === "ban" && o.userId === u("eve")).map((o) => o.roomId).sort();
  assert.deepEqual(bans, [id("gate"), id("general"), id("hub"), id("lounge"), id("mods"), id("news"), id("staff"), id("talk"), id("vip")].sort());
  // Lifted by the site (mallory no longer in `banned`; the room bans carry the site's marker) → unbanned everywhere.
  const d = fresh().desired; d.banned = [];
  const unbans = planMembership(d, fresh().actual).filter((o) => o.op === "unban");
  assert.equal(unbans.length, 9);
  assert.ok(unbans.every((o) => o.userId === u("mallory")));
});

const ALL_ROOMS = [id("gate"), id("general"), id("hub"), id("lounge"), id("mods"), id("news"), id("staff"), id("talk"), id("vip")].sort();
/** mallory's nine room bans, made by hand (no reason, or another reason) instead of by the site. */
const handMade = (actual, reason) => { for (const r of Object.values(actual.rooms)) if (r.banReasons) { if (reason === undefined) delete r.banReasons; else r.banReasons = { [u("mallory")]: reason }; } };

test("site_marked_room_bans_are_lifted_when_the_site_ban_ends", () => {
  const { desired, actual } = fresh();
  desired.banned = [];
  const plan = apply(desired, actual);
  assert.deepEqual(plan.ops.filter((o) => o.op === "unban").map((o) => o.roomId).sort(), ALL_ROOMS);
  assert.deepEqual(plan.drift, [], "a lifted site ban is not drift");
  // It is site state, not an Element edit: it applies with put-back off too.
  desired.putBack = false;
  assert.equal(apply(desired, actual).ops.filter((o) => o.op === "unban").length, 9);
  // Exactly the marker (the core writes exactly it; the browser sync compares with ===): a mod's reason that
  // merely begins with the phrase is the mod's own, never lifted.
  for (const r of Object.values(actual.rooms)) if (r.banReasons) r.banReasons[u("mallory")] = `${desired.siteBanReason}, and more`;
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "unban"), "a longer reason is not the marker");
  // Still banned on the site: nothing lifted.
  desired.banned = [u("mallory")];
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "unban"));
});

test("hand_made_room_bans_are_never_lifted_even_if_the_site_lifted_a_ban", () => {
  // mallory is banned in every room by hand. The site lifted its own ban on mallory (an older site also
  // listed them in a since-removed `unbanned` field), and that must not reach a ban a mod made in a room.
  for (const reason of [undefined, "spam", `spam (${fresh().desired.siteBanReason})`, `${fresh().desired.siteBanReason}, and more`]) {
    const { desired, actual } = fresh();
    handMade(actual, reason);
    desired.banned = [];
    desired.unbanned = [u("mallory")];
    for (const mode of ["apply", "report"]) {
      const plan = planAll(desired, actual, { mode });
      assert.ok(!plan.ops.some((o) => o.op === "unban"), `${mode} ${reason}`);
      const hand = plan.drift.filter((e) => e.kind === "ban");
      assert.equal(hand.length, 9, `${mode} ${reason}`);
      assert.ok(hand.every((e) => e.userId === u("mallory") && typeof e.roomId === "string" && e.op === undefined));
    }
    assert.match(describe(planAll(desired, actual, { mode: "apply" }).drift[0]), /^@mallory:example\.test is banned from .+, but not by the site/);
  }
});

test("core_ban_ops_carry_the_site_marker", () => {
  const { desired, actual } = fresh();
  desired.banned.push(u("eve"));
  const bans = planMembership(desired, actual).filter((o) => o.op === "ban");
  assert.equal(bans.length, 9);
  assert.ok(bans.every((o) => o.reason === desired.siteBanReason), JSON.stringify(bans[0]));
  assert.equal(desired.siteBanReason, "Banned by the example site", "vacuity: the marker comes from the feed, not a copy in the core");
  // A feed without the marker (a site older than this reconciler): no ban or unban the core could not
  // tell apart later, and one warning.
  delete desired.siteBanReason;
  desired.banned = [u("eve")];
  const ops = planMembership(desired, actual);
  assert.ok(!ops.some((o) => o.op === "ban" || o.op === "unban"));
  assert.equal(ops.filter((o) => o.code === "site_ban_reason_unknown").length, 1);
  // No marker is no match, whatever a mod wrote (startsWith(null) would test for the text "null").
  for (const r of Object.values(actual.rooms)) if (r.banReasons) r.banReasons = { [u("mallory")]: "null and void" };
  desired.banned = [];
  assert.ok(!planMembership(desired, actual).some((o) => o.op === "unban"), "a reason beginning with \"null\" is a mod's own");
  // An empty marker would start every reason: it is no marker at all, and a mod's ban stays.
  desired.siteBanReason = "";
  desired.banned = [];
  const empty = planMembership(desired, actual);
  assert.ok(!empty.some((o) => o.op === "unban"), "an empty marker lifts nothing");
  assert.equal(empty.filter((o) => o.code === "site_ban_reason_unknown").length, 1);
});

test("ban_downgraded_to_timeout_lifts_the_room_bans_but_keeps_minus_one", () => {
  // The ban route's override turns mallory's permanent ban into a timeout in place: mallory leaves
  // `banned` and appears in `timedOut`. The site's room bans are lifted; posting stays at −1.
  const { desired, actual } = fresh();
  desired.banned = [];
  desired.timedOut.push({ userId: u("mallory"), until: "2026-10-30T00:00:00.000Z" });
  forgetPower(actual, "general");
  const { ops } = apply(desired, actual);
  assert.deepEqual(ops.filter((o) => o.op === "unban").map((o) => o.roomId).sort(), ALL_ROOMS);
  assert.equal(powerFor(ops, id("general")).users[u("mallory")], -1);
});

test("lapse_during_timeout_keeps_timeout", () => {
  const { desired, actual } = fresh();
  // tim is timed out and not a supporter (lapsed), yet inside the gated room and the gate: the lapse
  // removes him from both, and the timeout still holds him at −1 everywhere (Review Focus 2).
  actual.rooms[id("lounge")].members[u("tim")] = "join";
  actual.rooms[id("gate")].members[u("tim")] = "join";
  forgetPower(actual, "general", "news", "lounge", "mods", "vip", "staff");
  const { ops } = apply(desired, actual);
  assert.deepEqual(ops.filter((o) => o.op === "kick" && o.userId === u("tim")).map((o) => o.roomId).sort(), [id("gate"), id("lounge")]);
  for (const n of ["general", "news", "lounge", "mods", "vip", "staff"]) assert.equal(powerFor(ops, id(n)).users[u("tim")], -1, n);
  for (const s of ["talk", "gate"]) assert.equal(actual.rooms[id(s)].powerLevels.users[u("tim")], -1, `${s}: already -1 in the fixture`);
});

test("encryption_only_on_create", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "general").encrypted = true;
  const { ops } = apply(desired, actual);
  const g = opsFor(ops, id("general"));
  assert.deepEqual(kinds(g), ["warn"]);
  assert.equal(g[0].code, "encryption_only_at_create");
  // The other way: an encrypted room the row calls plain also only warns (it cannot be switched off).
  const d = fresh().desired; roomRow(d, "staff").encrypted = false;
  const s = opsFor(apply(d, fresh().actual).ops, id("staff"));
  assert.deepEqual(kinds(s), ["warn"]);
  assert.ok(!apply(d, fresh().actual).ops.some((o) => o.op === "createRoom"));
});

test("archive_sets_events_default_100_and_unlinks", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "news").archived = true;
  const { ops } = apply(desired, actual);
  const news = opsFor(ops, id("news"));
  assert.deepEqual(kinds(news), ["archive"]);
  assert.equal(news[0].content.events_default, 100);
  // Everything else about the room's settings is kept as it is.
  assert.deepEqual({ ...news[0].content, events_default: 50 }, actual.rooms[id("news")].powerLevels);
  const unlink = ops.filter((o) => o.op === "unlinkChild");
  assert.deepEqual(unlink.map((o) => [o.parentId, o.childId]), [[id("talk"), id("news")]]);
  // Archived is stable: once done, the next run is empty.
  actual.rooms[id("news")].powerLevels = news[0].content;
  actual.rooms[id("talk")].children = actual.rooms[id("talk")].children.filter((c) => c.roomId !== id("news"));
  assert.deepEqual(apply(desired, actual).ops, []);
  // Unarchive: the row comes back → the ladder is rewritten and the room linked again.
  roomRow(desired, "news").archived = false;
  const back = apply(desired, actual).ops;
  assert.deepEqual(kinds(back).sort(), ["linkChild", "unarchive"]);
  assert.equal(back.find((o) => o.op === "unarchive").content.events_default, 50);
  // An archived row with no room is never created.
  const d = fresh().desired, a = fresh().actual;
  roomRow(d, "news").archived = true; delete a.rooms[id("news")];
  assert.ok(!apply(d, a).ops.some((o) => o.op === "createRoom"));
});

test("not_joined_lists_hub_linked_rooms_the_account_is_not_in: from the hub's own links, never a room outside it", () => {
  const { desired, actual } = fresh();
  // Two rooms linked into the community that no row knows: one the account is in, one it is not
  // (a mod linked it, so the account never joined). A third room is linked nowhere (a stranger's).
  actual.hub.children.push({ roomId: id("found"), order: "b0", via: [S] }, { roomId: id("locked"), order: "b1", via: [S] });
  actual.rooms[id("hub")].children = actual.hub.children;
  actual.rooms[id("found")] = { ...structuredClone(actual.rooms[id("general")]), name: "found" };
  actual.rooms[id("locked")] = { unreadable: true, creators: [] };
  actual.rooms[id("stranger")] = { unreadable: true, creators: [] };
  for (const mode of ["report", "apply"]) {
    const plan = planAll(desired, actual, { mode });
    const warns = [...plan.ops, ...plan.drift].filter((o) => o.op === "warn");
    assert.deepEqual(warns.filter((o) => o.code === "not_joined").map((o) => o.roomId), [id("locked")], mode);
    assert.match(describe(warns.find((o) => o.code === "not_joined")), /is linked into the community, but the community's account is not in it/);
    assert.deepEqual(warns.filter((o) => o.code === "not_in_panel").map((o) => o.roomId), [id("found")], `${mode}: a room it can read is still "not in the panel"`);
    assert.ok(!warns.some((o) => o.roomId === id("stranger")), `${mode}: a room outside the community is never listed`);
    assert.ok(![...plan.ops, ...plan.drift].some((o) => o.op !== "warn" && (o.roomId === id("locked") || o.childId === id("locked"))), `${mode}: never touched`);
  }
});

test("adopt_never_deletes_unknown_rooms", () => {
  const { desired, actual } = fresh();
  // Rooms in the hub nobody's row knows: one under the hub, one under a category, one a space.
  const room = (o) => ({ name: null, topic: null, avatar: null, joinRule: "invite", allow: [], history: "shared", retention: null, encrypted: false, published: false, powerLevels: { events_default: 0, users: {} }, members: { [u("bob")]: "join" }, tombstone: null, creators: [u("streamer")], ...o });
  actual.hub.children.push({ roomId: id("found"), order: "b0", via: [S] }, { roomId: id("games"), order: "b1", via: [S] });
  actual.rooms[id("hub")].children = actual.hub.children;
  actual.rooms[id("talk")].children.push({ roomId: id("side"), order: "a9", via: [S] });
  actual.rooms[id("found")] = room({ name: "found", topic: "made in Element", joinRule: "restricted", allow: [{ type: "m.room_membership", room_id: id("hub") }], published: true, retention: 7 * 86400000, powerLevels: { events_default: 50, users: {} } });
  actual.rooms[id("side")] = room({ name: "side", encrypted: true, powerLevels: { events_default: 10, users: {} } });
  actual.rooms[id("games")] = room({ type: "m.space", name: "Games", children: [{ roomId: id("chess"), order: "a0", via: [S] }] });
  actual.rooms[id("chess")] = room({ name: "chess", forum: true, joinRule: "restricted", allow: [{ type: "m.room_membership", room_id: id("hub") }] });
  const unknown = [id("found"), id("side"), id("games"), id("chess")];
  // apply touches none of them: no unlink, kick, archive, settings or power write.
  const ap = apply(desired, actual);
  const touching = [...ap.ops, ...ap.drift].filter((o) => unknown.includes(o.roomId) || unknown.includes(o.childId));
  assert.deepEqual(touching.filter((o) => o.op !== "warn"), []);
  assert.ok(touching.some((o) => o.code === "not_in_panel"), "it says they are there");
  // adopt turns each into a row as it is, parents first, and does nothing else.
  const ad = planAll(desired, actual, { mode: "adopt" });
  assert.deepEqual(new Set(kinds(ad.ops)), new Set(["adoptRow"]));
  // Depth first through the hierarchy, so a parent is always adopted before its children.
  assert.deepEqual(ad.ops.map((o) => o.matrixRoomId), [id("side"), id("found"), id("games"), id("chess")]);
  const row = (r) => ad.ops.find((o) => o.matrixRoomId === id(r)).row;
  assert.deepEqual(row("found"), { kind: "text", name: "found", topic: "made in Element", avatarMxc: null, orderKey: "b0", see: "everyone", post: "mods", retentionDays: 7, encrypted: false, published: true, archived: false, matrixRoomId: id("found"), discordChannelId: null });
  assert.equal(ad.ops.find((o) => o.matrixRoomId === id("found")).table, "rooms");
  assert.equal(ad.ops.find((o) => o.matrixRoomId === id("found")).parentRoomId, id("hub"));
  assert.deepEqual([row("side").see, row("side").post, row("side").encrypted], ["invited", "supporters", true], "never wider than the room is");
  assert.equal(ad.ops.find((o) => o.matrixRoomId === id("games")).table, "spaces");
  assert.deepEqual(row("games"), { kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "b1", matrixRoomId: id("games"), gateTier: null });
  assert.equal(ad.ops.find((o) => o.matrixRoomId === id("chess")).parentRoomId, id("games"));
  assert.equal(row("chess").kind, "forum");
  assert.deepEqual(ad.drift, []);
});

test("adopt_imports_the_hub_when_no_row_has_it", () => {
  const { desired, actual } = fresh();
  desired.spaces = desired.spaces.filter((s) => s.kind !== "hub");
  desired.spaces[0].parentId = null;
  const ops = planAll(desired, actual, { mode: "adopt" }).ops;
  assert.deepEqual(ops.map((o) => [o.op, o.table, o.matrixRoomId, o.row.kind]), [["adoptRow", "spaces", id("hub"), "hub"]]);
  assert.equal(ops[0].row.name, "Example Community");
});

test("apply_recreates_missing_room_when_row_says_so", () => {
  const { desired, actual } = fresh();
  // #general was removed by hand (the service account is no longer in it): the row still lists it.
  delete actual.rooms[id("general")];
  actual.rooms[id("talk")].children = actual.rooms[id("talk")].children.filter((c) => c.roomId !== id("general"));
  const { ops } = apply(desired, actual);
  const c = ops.find((o) => o.op === "createRoom");
  assert.ok(c); assert.equal(c.replaces, id("general")); assert.deepEqual(c.row, { table: "rooms", id: 1 });
  assert.equal(ops.filter((o) => o.op === "createRoom").length, 1);
  assert.ok(ops.some((o) => o.op === "linkChild" && o.childId === c.ref));
  // A room the reconciler cannot read is NOT recreated: it warns and leaves it.
  const a = fresh().actual; a.rooms[id("general")] = { unreadable: true };
  const ops2 = apply(fresh().desired, a).ops;
  assert.ok(!ops2.some((o) => o.op === "createRoom"));
  assert.deepEqual(kinds(opsFor(ops2, id("general"))), ["warn"]);
  // A Discord-linked room that is gone is not recreated either (the bridge owns the link).
  const d3 = fresh().desired; roomRow(d3, "general").discordChannelId = "100000000000000001";
  const ops3 = apply(d3, actual).ops;
  assert.ok(!ops3.some((o) => o.op === "createRoom"));
  assert.ok(ops3.some((o) => o.op === "warn" && o.roomId === id("general")));
});

test("adopt_follows_tombstone", () => {
  const { desired, actual } = fresh();
  actual.rooms[id("general")].tombstone = { replacement_room: id("general2"), body: "upgraded" };
  actual.rooms[id("general2")] = { ...actual.rooms[id("general")], tombstone: { replacement_room: id("general3") } };
  actual.rooms[id("general3")] = { ...actual.rooms[id("general")], tombstone: null };
  const ad = planAll(desired, actual, { mode: "adopt" });
  assert.deepEqual(ad.ops.filter((o) => o.op === "followTombstone"),
    [{ op: "followTombstone", table: "rooms", rowId: 1, roomId: id("general"), to: id("general3"), label: "#general" }]);
  // apply does not treat the upgraded room as missing (no recreate), and touches it no further.
  const ap = apply(desired, actual);
  assert.ok(!ap.ops.some((o) => o.op === "createRoom"));
  assert.deepEqual(kinds(opsFor(ap.ops, id("general"))), ["warn"]);
  // A tombstone loop stops.
  actual.rooms[id("general3")].tombstone = { replacement_room: id("general") };
  assert.ok(Array.isArray(planAll(desired, actual, { mode: "adopt" }).ops));
});

test("report_mode_has_no_side_effects", () => {
  const { desired, actual } = fresh();
  actual.rooms[id("general")].name = "lobby";
  actual.rooms[id("news")].topic = "hand-made";
  delete actual.rooms[id("mods")].members[u("moddy")];
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", matrixRoomId: null });
  const before = JSON.stringify({ desired, actual });
  const report = planAll(desired, actual, { mode: "report" });
  assert.equal(report.mode, "report");
  assert.deepEqual(report.ops, [], "report performs nothing");
  // It lists exactly what apply would do.
  assert.deepEqual(report.drift, apply(desired, actual).ops);
  assert.ok(report.drift.length >= 4);
  assert.equal(JSON.stringify({ desired, actual }), before, "inputs untouched");
  assert.throws(() => planAll(desired, actual, { mode: "fix" }), /mode/);
});

test("keep_element_edits_contract: put-back off reports drift without ops", () => {
  const { desired, actual } = fresh();
  desired.putBack = false;
  const g = actual.rooms[id("general")];
  g.name = "lobby"; g.topic = "hand-made"; g.avatar = "mxc://example.test/abc"; g.history = "joined"; g.joinRule = "public"; g.allow = [];
  actual.rooms[id("talk")].name = "Chat";
  forgetPower(actual, "news");
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", matrixRoomId: null });
  const { ops, drift } = apply(desired, actual);
  const put = ["rename", "setTopic", "setAvatar", "setHistory", "setJoinRule", "renameSpace", "setPowerRules"];
  assert.deepEqual(ops.filter((o) => put.includes(o.op)), []);
  assert.deepEqual(kinds(drift).sort(), [...put].sort());
  // Creates, the ladder and membership still apply: #news's ladder is written, its other
  // power-level settings (who can post, the per-event table) are a drift entry.
  assert.ok(ops.some((o) => o.op === "createRoom"));
  assert.deepEqual(powerFor(ops, id("news")), { users: fresh().actual.rooms[id("news")].powerLevels.users });
  assert.equal(drift.find((o) => o.op === "setPowerRules").roomId, id("news"));
  // With put-back on, the same changes are ops.
  desired.putBack = true;
  const on = apply(desired, actual);
  assert.deepEqual(on.drift, []);
  for (const k of put.filter((x) => x !== "setPowerRules")) assert.ok(on.ops.some((o) => o.op === k), k);
  // …and #news's power levels are one whole write.
  assert.equal(powerFor(on.ops, id("news")).events_default, 50);
  assert.ok(!on.ops.some((o) => o.op === "setPowerRules"));
});

test("bridged_rooms_keep_bridge_owned_fields", () => {
  const { desired, actual } = fresh();
  roomRow(desired, "general").discordChannelId = "100000000000000001";
  const g = actual.rooms[id("general")];
  g.topic = "set from Discord"; g.joinRule = "public"; g.allow = [];
  g.powerLevels = { ...g.powerLevels, events: { "m.room.power_levels": 100, "m.room.topic": 0 }, users: { ...g.powerLevels.users, [u("_bridge_bot")]: 100 } };
  actual.rooms[id("talk")].children = actual.rooms[id("talk")].children.filter((c) => c.roomId !== id("general"));
  g.name = "general-renamed";
  const { ops, drift } = apply(desired, actual);
  const mine = [...ops, ...drift].filter((o) => o.roomId === id("general") || o.childId === id("general"));
  assert.ok(!mine.some((o) => ["setJoinRule", "linkChild", "setOrder", "unlinkChild"].includes(o.op)), JSON.stringify(kinds(mine)));
  assert.ok(mine.some((o) => o.op === "rename"), "the name is still the panel's");
  // The topic too, when the row has one (OOYE then keeps it as the room's own); with none, the
  // bridge's stays (reconcile-ooye.test.mjs runs this against the state OOYE really writes).
  assert.ok(mine.some((o) => o.op === "setTopic" && o.topic === "Say hello"));
  roomRow(desired, "general").topic = null;
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "setTopic" && o.roomId === id("general")));
  roomRow(desired, "general").topic = "Say hello";
  // Power: the bridge's own grants and its per-event table stay; nothing to write when the ladder holds.
  assert.ok(!mine.some((o) => o.op === "setPowerLevels"));
  // A ladder change is written with the bridge's parts kept.
  desired.people.push({ userId: u("newmod"), level: 50 });
  const c = powerFor(apply(desired, actual).ops, id("general"));
  assert.equal(c.users[u("newmod")], 50);
  assert.equal(c.users[u("_bridge_bot")], 100);
  assert.deepEqual(c.events, { "m.room.power_levels": 100, "m.room.topic": 0 });
  // Bans the bridge mirrored from Discord are not lifted.
  g.members[u("discordbanned")] = "ban";
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "unban" && o.roomId === id("general")));
});

test("timed_out_mod_keeps_rooms_in_people_and_loses_them_when_absent", () => {
  // The core REQUIRES Task 1.3's fixed feed: a timed-out person stays in `people` at their level.
  // Then a timed-out mod keeps every room and is −1 everywhere.
  const { desired, actual } = fresh();
  desired.timedOut.push({ userId: u("moddy"), until: "2026-10-24T00:00:00.000Z" });
  forgetPower(actual, "general", "news", "lounge", "mods", "vip", "staff");
  const kept = apply(desired, actual).ops;
  assert.deepEqual(kept.filter((o) => o.op === "kick"), []);
  for (const n of ["general", "news", "lounge", "mods", "vip", "staff"]) assert.equal(powerFor(kept, id(n)).users[u("moddy")], -1, n);
  // The old shape (left out of `people`) reads as a lost rung: removed from the mods room, the gate
  // and the supporter room — and still −1 everywhere for the timeout.
  desired.people = desired.people.filter((p) => p.userId !== u("moddy"));
  const lost = apply(desired, actual).ops;
  assert.deepEqual(lost.filter((o) => o.op === "kick").map((o) => o.roomId).sort(), [id("gate"), id("lounge"), id("mods")]);
  for (const n of ["general", "news", "lounge", "mods", "vip", "staff"]) assert.equal(powerFor(lost, id(n)).users[u("moddy")], -1, n);
});

/** Discord-linked mods and supporter rooms holding bridge accounts and a native who lost the rung. */
function linkedRooms(patterns) {
  const { desired, actual } = fresh();
  if (patterns) desired.bridgeUserPatterns = patterns;
  roomRow(desired, "mods").discordChannelId = "100000000000000002";
  roomRow(desired, "lounge").discordChannelId = "100000000000000003";
  for (const r of ["mods", "lounge"]) {
    actual.rooms[id(r)].members[u("_ooye_bot")] = "join";
    actual.rooms[id(r)].members[u("_ooye_someone")] = "join";
    actual.rooms[id(r)].members[u("bob")] = "join"; // native, never entitled here
  }
  delete actual.rooms[id("mods")].members[u("moddy")];
  return { desired, actual };
}

test("linked_rooms_kick_natives_but_never_bridge_accounts", () => {
  // The registration's own shape: a whole-id pattern (the core anchors it at both ends).
  const { desired, actual } = linkedRooms(["@_ooye_.*:example\\.test"]);
  const ops = planMembership(desired, actual);
  assert.deepEqual(ops.filter((o) => o.op === "kick").map((o) => [o.roomId, o.userId]).sort(),
    [[id("lounge"), u("bob")], [id("mods"), u("bob")]]);
  assert.ok(ops.some((o) => o.op === "invite" && o.roomId === id("mods") && o.userId === u("moddy")), "invites still go out");
  assert.ok(!ops.some((o) => o.op === "warn"));
  // A bridge account's room ban is not reported as hand-made either.
  actual.rooms[id("mods")].members[u("_ooye_banned")] = "ban";
  assert.ok(!planAll(desired, actual, { mode: "apply" }).drift.some((e) => e.userId === u("_ooye_banned")));
  // The patterns only guard linked rooms: in an unlinked mods room everyone off the rung goes.
  roomRow(desired, "mods").discordChannelId = null;
  assert.deepEqual(planMembership(desired, actual).filter((o) => o.op === "kick" && o.roomId === id("mods")).map((o) => o.userId),
    [u("_ooye_bot"), u("_ooye_someone"), u("bob")]);
});

test("linked_rooms_without_patterns_warn_and_skip_kicks", () => {
  for (const patterns of [undefined, [], ["("]]) { // absent, empty, none valid
    const { desired, actual } = linkedRooms(patterns);
    const ops = planMembership(desired, actual);
    assert.deepEqual(ops.filter((o) => o.op === "kick"), [], JSON.stringify(patterns));
    const warns = ops.filter((o) => o.op === "warn" && o.code === "bridge_accounts_unknown");
    assert.deepEqual(warns.map((w) => w.roomId).sort(), [id("lounge"), id("mods")]);
    assert.equal(describe(warns.find((w) => w.roomId === id("mods"))), "bridge accounts unknown in #mods: every existing grant is kept and nobody is removed");
    assert.ok(ops.some((o) => o.op === "invite" && o.userId === u("moddy")), "invites still go out");
  }
});

test("linked_rooms_drop_stale_native_grants_but_keep_bridge_grants", () => {
  // #general is linked to Discord. Its settings hold the bridge's grants and a 50 for exmod, a mod the
  // site has since demoted (no longer in `people`).
  const setup = (patterns) => {
    const { desired, actual } = fresh();
    if (patterns) desired.bridgeUserPatterns = patterns;
    roomRow(desired, "general").discordChannelId = "100000000000000001";
    const g = actual.rooms[id("general")];
    g.powerLevels = { ...g.powerLevels, users: { ...g.powerLevels.users, [u("_ooye_bot")]: 100, [u("_ooye_puppet")]: 50, [u("exmod")]: 50 } };
    return { desired, actual };
  };
  const { desired, actual } = setup(["@_ooye_[a-z]+:example\\.test"]);
  const ops = apply(desired, actual).ops;
  const c = powerFor(ops, id("general"));
  assert.ok(c, "the stale grant is written out");
  assert.equal(c.users[u("exmod")], undefined, "a demoted mod loses the grant in a linked room too");
  assert.equal(c.users[u("_ooye_bot")], 100);
  assert.equal(c.users[u("_ooye_puppet")], 50);
  assert.equal(c.users[u("moddy")], 50, "the ladder is there");
  assert.ok(!ops.some((o) => o.op === "warn" && o.code === "bridge_accounts_unknown"));
  // With the bridge accounts unknown, every existing grant stays, and the panel is told why.
  const un = setup(undefined);
  const ops2 = apply(un.desired, un.actual).ops;
  assert.ok(!ops2.some((o) => o.op === "setPowerLevels" && o.roomId === id("general")), "nothing dropped");
  const w = ops2.find((o) => o.op === "warn" && o.code === "bridge_accounts_unknown" && o.roomId === id("general"));
  assert.ok(w); assert.match(describe(w), /^bridge accounts unknown in #general: /);
});

test("bridge_patterns_are_anchored", () => {
  // A registration pattern written without ^…$: it must match whole ids only.
  const { desired, actual } = linkedRooms(["@_ooye_[a-z]+:example\\.test"]);
  const mods = actual.rooms[id("mods")].members;
  mods[u("_ooye_bot")] = "join"; // matches whole
  mods["@_ooye_x:example.test.evil.org"] = "join"; // matches only as a prefix
  mods["@x_ooye_a:example.test"] = "join"; // would match from the middle if the start were not anchored
  const kicked = planMembership(desired, actual).filter((o) => o.op === "kick" && o.roomId === id("mods")).map((o) => o.userId);
  assert.ok(kicked.includes("@_ooye_x:example.test.evil.org"), JSON.stringify(kicked));
  assert.ok(!kicked.includes(u("_ooye_bot")));
  // (the start anchor: an id with the pattern inside it is not a bridge account)
  delete mods["@x_ooye_a:example.test"]; mods["@x@_ooye_a:example.test"] = "join";
  assert.ok(planMembership(desired, actual).some((o) => o.op === "kick" && o.userId === "@x@_ooye_a:example.test"));
  // A pattern already anchored works the same.
  const a2 = linkedRooms(["^@_ooye_[a-z]+:example\\.test$"]);
  a2.actual.rooms[id("mods")].members["@_ooye_x:example.test.evil.org"] = "join";
  const k2 = planMembership(a2.desired, a2.actual).filter((o) => o.op === "kick" && o.roomId === id("mods")).map((o) => o.userId);
  assert.ok(k2.includes("@_ooye_x:example.test.evil.org")); assert.ok(!k2.includes(u("_ooye_bot")));
});

test("empty_bridge_pattern_is_not_usable", () => {
  // A pattern that accepts the empty string matches (almost) anything: not usable, so the room gets
  // no removals and a warning — never "everyone is a bridge account" silently.
  for (const patterns of [[""], [".*"], ["(?:)"], ["", "("]]) {
    const { desired, actual } = linkedRooms(patterns);
    const ops = planMembership(desired, actual);
    assert.deepEqual(ops.filter((o) => o.op === "kick"), [], JSON.stringify(patterns));
    assert.ok(ops.some((o) => o.op === "warn" && o.code === "bridge_accounts_unknown" && o.roomId === id("mods")), JSON.stringify(patterns));
  }
  // One usable pattern beside an empty one is enough.
  const { desired, actual } = linkedRooms(["", "@_ooye_[a-z]+:example\\.test"]);
  assert.deepEqual(planMembership(desired, actual).filter((o) => o.op === "kick").map((o) => o.userId), [u("bob"), u("bob")]);
});

test("created_spaces_carry_their_kind", () => {
  // The client tells a gate from a category by app.blackbranch.space_kind (spec §4.3).
  const { desired, actual } = fresh();
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "a2", matrixRoomId: null, gateTier: null });
  delete actual.rooms[id("gate")]; desired.spaces[2].matrixRoomId = null;
  const creates = apply(desired, actual).ops.filter((o) => o.op === "createSpace");
  assert.deepEqual(creates.map((o) => [o.row.id, o.body.creation_content]), [
    [3, { type: "m.space", "app.blackbranch.space_kind": "gate" }],
    [4, { type: "m.space", "app.blackbranch.space_kind": "category" }],
  ]);
  // A created space needs no separate marker: its create content holds it for good.
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "setState"));
  // A room's create content carries no space kind.
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", matrixRoomId: null });
  assert.deepEqual(apply(desired, actual).ops.find((o) => o.op === "createRoom").body.creation_content, {});
});

test("existing_spaces_without_the_marker_get_a_state_event", () => {
  // Create content cannot change after the fact, so an adopted or older space gets a state event.
  const { desired, actual } = fresh();
  delete actual.rooms[id("hub")].spaceKind;
  delete actual.rooms[id("gate")].spaceKind;
  actual.rooms[id("talk")].spaceKind = "gate"; // a wrong marker is put right too
  const ops = apply(desired, actual).ops.filter((o) => o.op === "setState");
  assert.deepEqual(ops.map((o) => [o.roomId, o.type, o.stateKey, o.content]), [
    [id("hub"), "app.blackbranch.space_kind", "", { kind: "hub" }],
    [id("talk"), "app.blackbranch.space_kind", "", { kind: "category" }],
    [id("gate"), "app.blackbranch.space_kind", "", { kind: "gate" }],
  ]);
  assert.ok(ops.every((o) => !o.putBack), "a marker always applies");
  assert.equal(describe(ops[2]), "mark the hidden supporters space so apps know it is the hidden supporters space");
  // Once marked, nothing more; and a channel never gets one.
  for (const o of ops) actual.rooms[o.roomId].spaceKind = o.content.kind;
  assert.deepEqual(apply(desired, actual).ops, []);
});

test("null_retention_writes_the_cap_when_the_cap_is_on", () => {
  // A row with no days means "as long as this server allows": the cap, written out (never the
  // server's default policy, which may be shorter).
  const { desired, actual } = fresh();
  actual.rooms[id("news")].retention = null;      // an event with no limit
  delete actual.rooms[id("lounge")].retention;    // no event at all
  const ops = apply(desired, actual).ops.filter((o) => o.op === "setRetention");
  assert.deepEqual(ops.map((o) => [o.roomId, o.content, o.days]), [
    [id("news"), { max_lifetime: 365 * 86400000 }, 365],
    [id("lounge"), { max_lifetime: 365 * 86400000 }, 365],
  ]);
  assert.equal(describe(ops[0]), "keep messages in #news for 365 days");
  // Explicit days stay capped as before.
  roomRow(desired, "general").retentionDays = 400;
  assert.deepEqual(apply(desired, actual).ops.find((o) => o.op === "setRetention" && o.roomId === id("general")).content, { max_lifetime: 365 * 86400000 });
  // A room the plan creates carries the cap too.
  desired.rooms.push({ ...roomRow(desired, "news"), id: 7, name: "clips", matrixRoomId: null });
  const body = apply(desired, actual).ops.find((o) => o.op === "createRoom").body;
  assert.deepEqual(body.initial_state.find((x) => x.type === "m.room.retention").content, { max_lifetime: 365 * 86400000 });
});

test("null_retention_writes_no_limit_when_the_cap_is_off", () => {
  for (const cap of [0, null, undefined]) {
    const { desired, actual } = fresh();
    if (cap === undefined) delete desired.retentionCapDays; else desired.retentionCapDays = cap;
    // The fixture holds 365 days in the five rooms with no days: each is set to keep forever ({}).
    const ops = apply(desired, actual).ops.filter((o) => o.op === "setRetention");
    assert.deepEqual(ops.map((o) => o.roomId).sort(), [id("lounge"), id("mods"), id("news"), id("staff"), id("vip")], String(cap));
    for (const o of ops) { assert.deepEqual(o.content, {}); assert.equal(o.days, null); }
    assert.equal(describe(ops[0]), `keep messages in ${ops[0].label} forever`);
    // Explicit days are written as they are (no cap): #general's 30 days already match.
    roomRow(desired, "general").retentionDays = 400;
    assert.deepEqual(apply(desired, actual).ops.find((o) => o.roomId === id("general") && o.op === "setRetention").content, { max_lifetime: 400 * 86400000 });
    roomRow(desired, "general").retentionDays = 30;
    // {} ↔ null: once written, a room with an event and no limit is in step; a room with NO event
    // (the server's default policy would apply) still gets one.
    for (const o of ops) actual.rooms[o.roomId].retention = null;
    assert.deepEqual(apply(desired, actual).ops, [], String(cap));
    delete actual.rooms[id("vip")].retention;
    assert.deepEqual(apply(desired, actual).ops.map((o) => [o.op, o.roomId, o.content]), [["setRetention", id("vip"), {}]]);
    // A created room carries the empty event.
    desired.rooms.push({ ...roomRow(desired, "news"), id: 7, name: "clips", matrixRoomId: null });
    const body = apply(desired, actual).ops.find((o) => o.op === "createRoom").body;
    assert.deepEqual(body.initial_state.find((x) => x.type === "m.room.retention").content, {});
  }
});

test("hidden_accounts_are_never_kicked", () => {
  const { desired, actual } = fresh();
  for (const r of ["gate", "lounge", "mods", "staff"]) actual.rooms[id(r)].members[u("reader")] = "join";
  assert.deepEqual(planMembership(desired, actual).filter((o) => o.op === "kick"), []);
  // Not hidden → removed from the same rooms.
  desired.hiddenUserIds = [u("community")];
  assert.deepEqual(planMembership(desired, actual).filter((o) => o.op === "kick").map((o) => o.roomId).sort(),
    [id("gate"), id("lounge"), id("mods"), id("staff")]);
});

test("put_back_off_turns_hand_order_link_listing_and_retention_into_drift", () => {
  const { desired, actual } = fresh();
  desired.putBack = false;
  const talk = actual.rooms[id("talk")];
  talk.children.find((c) => c.roomId === id("news")).order = "zz";          // reordered by hand
  talk.children = talk.children.filter((c) => c.roomId !== id("mods"));     // unlinked by hand
  actual.hub.children.push({ roomId: id("vip"), order: "b0", via: [S] });   // linked elsewhere by hand
  actual.rooms[id("general")].published = false;                           // unlisted by hand
  actual.rooms[id("general")].retention = 5 * 86400000;                    // retention changed by hand
  roomRow(desired, "staff").archived = true;                               // the panel archives a room
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, name: "clips", orderKey: "a6", matrixRoomId: null });
  const { ops, drift } = apply(desired, actual);
  assert.deepEqual(kinds(drift).sort(), ["linkChild", "publish", "setOrder", "setRetention", "unlinkChild"]);
  assert.equal(drift.find((o) => o.op === "unlinkChild").childId, id("vip"));
  // Creates (with their link and listing), archives (with their unlink), power and membership still apply.
  assert.ok(ops.some((o) => o.op === "createRoom"));
  assert.ok(ops.some((o) => o.op === "linkChild" && o.childId === pendingRef("rooms", 7)));
  assert.ok(ops.some((o) => o.op === "publish" && o.roomId === pendingRef("rooms", 7)));
  assert.ok(ops.some((o) => o.op === "archive" && o.roomId === id("staff")));
  assert.ok(ops.some((o) => o.op === "unlinkChild" && o.childId === id("staff")));
  // Put-back on: the same changes are ops.
  desired.putBack = true;
  const on = apply(desired, actual);
  assert.deepEqual(on.drift, []);
  for (const k of ["linkChild", "unlinkChild", "publish", "setOrder", "setRetention"]) assert.ok(on.ops.some((o) => o.op === k && o.putBack), k);
});

test("unmanaged_power_level_keys_are_kept_and_not_churned", () => {
  // Synapse adds "historical": 100 to every room it makes (Task 1.6, real pair); a key the core does not
  // manage is left as found: never a reason to write, and kept when the core writes for another reason.
  const { desired, actual } = fresh();
  for (const n of ["hub", "talk", "gate", "general", "news", "lounge", "mods", "vip", "staff"]) {
    actual.rooms[id(n)].powerLevels = { ...actual.rooms[id(n)].powerLevels, historical: 100, "org.example.extra": { a: 1 } };
  }
  assert.deepEqual(apply(desired, actual).ops, [], "nothing to write");
  // A real difference (a new mod): the written content keeps the unmanaged keys as they were.
  desired.people.push({ userId: u("newmod"), level: 50 });
  const { ops } = apply(desired, actual);
  const written = powerFor(ops, id("general"));
  assert.equal(written.users[u("newmod")], 50, "vacuity: it writes");
  assert.equal(written.historical, 100);
  assert.deepEqual(written["org.example.extra"], { a: 1 });
  // A managed key is still the core's: a hand-made users_default is put back.
  const { desired: d2, actual: a2 } = fresh();
  a2.rooms[id("general")].powerLevels = { ...a2.rooms[id("general")].powerLevels, historical: 100, users_default: 10 };
  assert.equal(powerFor(apply(d2, a2).ops, id("general")).users_default, 0);
  // Unarchive writes the full content, keeping the unmanaged keys too.
  const { desired: d3, actual: a3 } = fresh();
  a3.rooms[id("news")].powerLevels = { ...a3.rooms[id("news")].powerLevels, events_default: 100, historical: 100 };
  const un = apply(d3, a3).ops.find((o) => o.op === "unarchive");
  assert.equal(un.content.historical, 100);
  // A room this plan makes carries only what the core manages (Synapse adds its own).
  const { desired: d4, actual: a4 } = fresh();
  d4.rooms.push({ ...roomRow(d4, "general"), id: 7, name: "clips", matrixRoomId: null });
  assert.equal(apply(d4, a4).ops.find((o) => o.op === "createRoom").body.power_level_content_override.historical, undefined);
});

test("unbans_are_sorted", () => {
  const { desired, actual } = fresh();
  desired.banned = [];
  actual.rooms[id("general")].members = { [u("zed")]: "ban", [u("amy")]: "ban", [u("mallory")]: "ban" };
  actual.rooms[id("general")].banReasons = Object.fromEntries([u("zed"), u("amy"), u("mallory")].map((x) => [x, desired.siteBanReason]));
  assert.deepEqual(opsFor(planMembership(desired, actual), id("general")).filter((o) => o.op === "unban").map((o) => o.userId),
    [u("amy"), u("mallory"), u("zed")]);
});

test("restart_after_partial_apply_plans_only_what_is_left", () => {
  // A run that died after creating the category (recorded in the row) but before its room and links.
  const { desired, actual } = fresh();
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "a2", matrixRoomId: id("games"), gateTier: null });
  desired.rooms.push({ ...roomRow(desired, "general"), id: 7, spaceId: 4, name: "chess", topic: null, retentionDays: null, matrixRoomId: null });
  actual.rooms[id("games")] = { ...actual.rooms[id("talk")], name: "Games", children: [] };
  const { ops } = apply(desired, actual);
  assert.ok(!ops.some((o) => o.op === "createSpace"), "the space is not made twice");
  // (The site ban reaches the new room at once: a restricted room is joinable the moment it exists.)
  assert.deepEqual(kinds(ops).sort(), ["ban", "createRoom", "linkChild", "linkChild", "publish"]);
  assert.ok(ops.some((o) => o.op === "linkChild" && o.parentId === id("hub") && o.childId === id("games")));
  assert.ok(ops.some((o) => o.op === "linkChild" && o.parentId === id("games") && o.childId === pendingRef("rooms", 7)));
});

test("retry_gives_the_same_plan", () => {
  const { desired, actual } = fresh();
  actual.rooms[id("general")].name = "lobby";
  delete actual.rooms[id("mods")].members[u("moddy")];
  forgetPower(actual, "vip");
  const a = apply(desired, actual), b = apply(desired, actual);
  assert.deepEqual(a, b);
  assert.ok(a.ops.length >= 3);
});

test("describe_says_each_op_in_plain_words", () => {
  const { desired, actual } = fresh();
  // Collect one of every op the planners emit.
  const g = roomRow(desired, "general");
  Object.assign(g, { name: "lobby", topic: "new", avatarMxc: "mxc://example.test/x", retentionDays: 60, published: false, orderKey: "a0V" });
  roomRow(desired, "news").archived = true;
  roomRow(desired, "mods").see = "everyone";
  roomRow(desired, "lounge").encrypted = true;
  actual.rooms[id("general")].history = "joined";
  desired.spaces[1].name = "Chat"; desired.spaces[1].topic = "t"; desired.spaces[1].avatarMxc = "mxc://example.test/y";
  desired.spaces[0].bannerMxc = "mxc://example.test/z";
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, orderKey: "a2", matrixRoomId: null, gateTier: null });
  desired.rooms.push({ ...roomRow(fresh().desired, "general"), id: 7, spaceId: 4, name: "chess", matrixRoomId: null });
  desired.supporters.push(u("sue")); desired.supporters = desired.supporters.filter((x) => x !== u("alice"));
  desired.banned = [u("eve")]; desired.unbanned = [u("mallory")];
  actual.rooms[id("vip")].members[u("handbanned")] = "ban";
  actual.rooms[id("general")].powerLevels = {};
  actual.rooms[id("staff")].powerLevels = { events_default: 100, users: {} };
  actual.rooms[id("unknown")] = { name: "unknown" }; actual.hub.children.push({ roomId: id("unknown"), order: "z", via: [S] });
  delete actual.rooms[id("talk")].spaceKind;
  const applied = apply(desired, actual);
  assert.ok(applied.drift.some((e) => e.kind === "ban"), "a hand-made ban to describe");
  const ops = [...applied.ops, ...applied.drift,
    ...planAll(desired, actual, { mode: "adopt" }).ops,
    { op: "followTombstone", table: "rooms", rowId: 1, roomId: id("general"), to: id("general2"), label: "#general" }];
  const seen = new Set(kinds(ops));
  for (const k of ["createSpace", "renameSpace", "setTopic", "setAvatar", "setBanner", "linkChild", "unlinkChild", "setOrder", "createRoom", "rename",
    "setJoinRule", "setHistory", "setRetention", "publish", "archive", "unarchive", "setPowerLevels", "invite", "kick", "ban", "unban", "setState",
    "warn", "adoptRow", "followTombstone"]) assert.ok(seen.has(k), `no ${k} op to describe`);
  for (const o of ops) {
    const s = describe(o);
    assert.equal(typeof s, "string"); assert.ok(s.length > 5, s);
    assert.doesNotMatch(s, /power.?level|join.?rule|state event|undefined|null|\[object/i, s);
  }
  assert.equal(describe(ops.find((o) => o.op === "rename")), "rename #general to #lobby");
  assert.throws(() => describe({ op: "nope" }), /nope/);
});

// ── The community's banner (Task 25): app.blackbranch.banner { url } on the hub space ──────────
const BANNER = "app.blackbranch.banner";
const MX_BANNER = "mxc://example.test/banner1";

test("banner: a banner set in the panel is written on the community space, and nowhere else", () => {
  const { desired, actual } = fresh();
  desired.spaces[0].bannerMxc = MX_BANNER;
  const { ops, drift } = apply(desired, actual);
  assert.deepEqual(drift, []);
  const set = ops.filter((o) => o.op === "setBanner");
  assert.equal(set.length, 1, JSON.stringify(ops.map(describe)));
  assert.equal(set[0].roomId, id("hub"));
  assert.equal(set[0].url, MX_BANNER);
  assert.equal(set[0].putBack, true, "undoing a banner changed in Element is a put-back");
  assert.equal(describe(set[0]), "change the banner of the community");
  // The icon is not touched: the banner is its own event.
  assert.ok(!ops.some((o) => o.op === "setAvatar"), "the hub's picture stays as it is");
  assert.equal(ops.length, 1, "nothing else changes");
});

test("banner restart: once the banner is on the space, the next run plans nothing", () => {
  const { desired, actual } = fresh();
  desired.spaces[0].bannerMxc = MX_BANNER;
  actual.rooms[id("hub")].banner = MX_BANNER;
  for (const mode of ["report", "apply"]) {
    const plan = planAll(desired, actual, { mode });
    assert.deepEqual([...plan.ops, ...plan.drift], [], mode);
  }
});

test("banner: removing it in the panel clears it; a banner changed in Element is put back, or only listed with put-back off", () => {
  const { desired, actual } = fresh();
  actual.rooms[id("hub")].banner = MX_BANNER;
  desired.spaces[0].bannerMxc = null;
  const cleared = apply(desired, actual).ops.find((o) => o.op === "setBanner");
  assert.ok(cleared, "a clear op");
  assert.equal(cleared.url, null);
  assert.equal(describe(cleared), "remove the banner of the community");
  desired.spaces[0].bannerMxc = "mxc://example.test/panel";
  desired.putBack = false;
  const off = apply(desired, actual);
  assert.ok(!off.ops.some((o) => o.op === "setBanner"));
  assert.equal(off.drift.filter((o) => o.op === "setBanner").length, 1);
});

test("banner: a feed without the field (an older site) never removes one", () => {
  const { desired, actual } = fresh();
  for (const s of desired.spaces) delete s.bannerMxc;
  actual.rooms[id("hub")].banner = MX_BANNER;
  assert.ok(!apply(desired, actual).ops.some((o) => o.op === "setBanner"));
});

test("banner: a space this plan creates carries its banner from the start", () => {
  const { desired, actual } = fresh();
  desired.spaces.push({ id: 4, parentId: 1, kind: "category", name: "Games", topic: null, avatarMxc: null, bannerMxc: MX_BANNER, orderKey: "a2", matrixRoomId: null, gateTier: null });
  const create = apply(desired, actual).ops.find((o) => o.op === "createSpace");
  assert.deepEqual(create.body.initial_state.find((s) => s.type === BANNER)?.content, { url: MX_BANNER });
  desired.spaces.at(-1).bannerMxc = null;
  const plain = apply(desired, actual).ops.find((o) => o.op === "createSpace");
  assert.equal(plain.body.initial_state.find((s) => s.type === BANNER), undefined);
});

// ── Source scans (negative assertions → anchored on the END of each file) ──────────────────────
const coreSrc = readFileSync(path.join(here, "matrix/reconcile-core.mjs"), "utf8");
test("the core is pure: it imports nothing and calls no network, file or clock", () => {
  assert.match(coreSrc, /\nexport function describe\(op\) \{\n[\s\S]*\n\}\n$/, "vacuity: the scan read to the end of the core");
  assert.doesNotMatch(coreSrc, /^\s*import\b/m);
  assert.doesNotMatch(coreSrc, /\bfetch\(|\brequire\(|process\.|Date\.now|new Date|Math\.random/);
});
test("vacuity: this file was read to its end", () => {
  const me = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(me, /\n\/\/ END: reconcile-core\.test\.mjs\n$/);
});
// END: reconcile-core.test.mjs
