// The reconciler against the room state the Discord bridge (OOYE 3.7) really writes when the panel
// links the community to a Discord server and a room to a channel (community plan task 2.4). The
// fixture is that state as Synapse 1.162 returned it (fixtures/community/ooye-linked.json: OOYE's own
// code in the bundle's image, Discord replaced by a stand-in), read through the command's own
// readRoom, so these tests see exactly what a run sees. A linked room is never fought: the plan for it
// is empty, and stays empty after the bridge's rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRoom } from "./matrix/reconcile.mjs";
import { planAll, describe } from "./matrix/reconcile-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(path.join(here, "fixtures/community/ooye-linked.json"), "utf8"));
const S = "bb.test";
const ME = `@blackbranch:${S}`;
const BOT = `@_ooye_bot:${S}`;
const HUB = `!hub:${S}`;
const GENERAL = `!general:${S}`;
const CHANNEL = "100000000000000201";
// The core's own marker on the hub (the bootstrap's hub carries it once the first run wrote it).
const KIND = { type: "app.blackbranch.space_kind", state_key: "", sender: ME, content: { kind: "hub" } };

/** A homeserver that answers readRoom with the captured state (#general listed, as the panel lists
 *  every channel everyone can see). */
function hsOf(states) {
  return {
    async request(method, p) {
      const m = /^\/rooms\/([^/]+)\/state$/.exec(p);
      if (m) {
        const events = states[decodeURIComponent(m[1])];
        return events ? { status: 200, json: events, text: "" } : { status: 404, json: { errcode: "M_NOT_FOUND" }, text: "" };
      }
      const d = /^\/directory\/list\/room\/(.+)$/.exec(p);
      if (d) return { status: 200, json: { visibility: decodeURIComponent(d[1]) === GENERAL ? "public" : "private" }, text: "" };
      throw new Error(`unexpected ${method} ${p}`);
    },
  };
}

async function actualOf(hubEvents, roomEvents) {
  const hs = hsOf({ [HUB]: hubEvents, [GENERAL]: roomEvents });
  const hub = await readRoom(hs, HUB, ME);
  const room = await readRoom(hs, GENERAL, ME);
  return { hub: { roomId: HUB, children: hub.children }, rooms: new Map([[HUB, hub], [GENERAL, room]]) };
}

/** The panel's side, as the site's feed sends it once the Discord bridge is on and the hub is linked. */
function feed({ linked = true, spaceLinked = true, bot = BOT } = {}) {
  return {
    serverName: S, hubRoomId: HUB, serviceUserId: ME, hiddenUserIds: [ME],
    spaces: [{ id: 1, parentId: null, kind: "hub", name: "Test Community", topic: null, avatarMxc: null, bannerMxc: null, orderKey: "a0", matrixRoomId: HUB, gateTier: null }],
    rooms: [{ id: 1, spaceId: 1, kind: "text", name: "general", topic: "Say hello", avatarMxc: null, orderKey: "a0", see: "everyone", post: "everyone",
      retentionDays: 180, encrypted: false, published: true, archived: false, matrixRoomId: GENERAL, discordChannelId: linked ? CHANNEL : null }],
    roles: [], people: [{ userId: `@streamer:${S}`, level: 100 }, { userId: `@moddy:${S}`, level: 50 }],
    supporters: [], banned: [], timedOut: [], putBack: true, retentionCapDays: 180, siteBanReason: "Banned by the site",
    bridgeBots: bot ? [bot] : [], bridgeUserPatterns: bot ? ["@_ooye_.*:bb\\.test"] : [],
    ...(bot ? { discordBot: bot } : {}), discordSpaceLinked: spaceLinked,
  };
}
const notWarn = (ops) => ops.filter((o) => o.op !== "warn");

test("a_linked_room_is_never_fought: after OOYE linked the hub and #general, the plan is empty", async () => {
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomLinked);
  // What OOYE changed, so the empty plan is not empty by accident: the hub's name and history, and the
  // room's join rule, notification level and per-event table.
  const hub = actual.rooms.get(HUB), room = actual.rooms.get(GENERAL);
  assert.equal(hub.name, "Stand-in Discord server");
  assert.equal(hub.history, "world_readable");
  assert.equal(room.joinRule, "public");
  assert.deepEqual(room.powerLevels.notifications, { room: 20 });
  assert.equal(room.powerLevels.events["m.reaction"], 0);
  assert.equal(room.powerLevels.users[BOT], 100);
  assert.deepEqual(room.bridgeHints, [BOT]);
  for (const mode of ["apply", "report"]) {
    const plan = planAll(feed(), actual, { mode });
    assert.deepEqual([...plan.ops, ...plan.drift].map(describe), [], mode);
  }
  // …and after a second run reads the same state (nothing was written), still nothing: no loop.
  assert.deepEqual(planAll(feed(), await actualOf([...FIX.hubLinked, KIND], FIX.roomLinked), { mode: "apply" }).ops, []);
});

test("seat: before linking, the bridge's bot is invited and seated at 100 in the hub and the linked room", async () => {
  // The hub as the bootstrap left it (no bot), and #general before OOYE touched it, its row already
  // marked for the channel: what the panel's Link press asks the server for first.
  const hubBefore = FIX.hubLinked.filter((e) => !(e.type === "m.room.member" && e.state_key === BOT))
    .map((e) => (e.type === "m.room.power_levels" ? { ...e, content: { ...e.content, users: {} } } : e));
  const actual = await actualOf([...hubBefore, KIND], FIX.roomBefore);
  const { ops } = planAll(feed({ spaceLinked: false }), actual, { mode: "apply" });
  const invites = ops.filter((o) => o.op === "invite").map((o) => [o.roomId, o.userId]);
  assert.deepEqual(invites, [[HUB, BOT], [GENERAL, BOT]]);
  const power = (rid) => ops.find((o) => o.op === "setPowerLevels" && o.roomId === rid)?.content;
  assert.equal(power(HUB).users[BOT], 100);
  assert.equal(power(GENERAL).users[BOT], 100);
  assert.equal(power(GENERAL).users[`@moddy:${S}`], 50, "the ladder is untouched");
  assert.match(describe(ops.find((o) => o.op === "invite" && o.roomId === HUB)), /^invite @_ooye_bot:bb\.test to the community$/);
});

test("no seat without the Discord bridge: an install with it off (or another bridge's rooms) gets no invite", async () => {
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomBefore);
  const { ops } = planAll(feed({ bot: null, spaceLinked: false }), actual, { mode: "apply" });
  assert.ok(!ops.some((o) => o.op === "invite" && o.userId === BOT));
  const hubWrite = ops.find((o) => o.op === "setPowerLevels" && o.roomId === HUB)?.content;
  assert.ok(!hubWrite || !(BOT in (hubWrite.users ?? {})) || hubWrite.users[BOT] === 100, "nothing new granted");
  // A bot the site has banned is never seated, wherever the feed names it.
  const banned = feed({ spaceLinked: false });
  banned.banned = [BOT];
  assert.ok(!planAll(banned, actual, { mode: "apply" }).ops.some((o) => o.op === "invite" && o.userId === BOT));
});

test("the panel's own settings still apply to a linked room: a rename, a topic and a picture it sets", async () => {
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomLinked);
  const f = feed();
  Object.assign(f.rooms[0], { name: "lobby", topic: "New topic", avatarMxc: "mxc://bb.test/pic" });
  const ops = planAll(f, actual, { mode: "apply" }).ops.filter((o) => o.roomId === GENERAL).map((o) => o.op).sort();
  assert.deepEqual(ops, ["rename", "setAvatar", "setTopic"]);
  // A ladder change is written with the bridge's parts kept.
  f.people.push({ userId: `@newmod:${S}`, level: 50 });
  const c = planAll(f, actual, { mode: "apply" }).ops.find((o) => o.op === "setPowerLevels" && o.roomId === GENERAL).content;
  assert.equal(c.users[`@newmod:${S}`], 50);
  assert.deepEqual(c.notifications, { room: 20 });
  assert.equal(c.events["m.reaction"], 0);
  assert.equal(c.users[BOT], 100);
});

test("the hub's name follows the Discord server only while it is linked", async () => {
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomLinked);
  const rename = (spaceLinked) => planAll(feed({ spaceLinked }), actual, { mode: "apply" }).ops.filter((o) => o.op === "renameSpace");
  assert.deepEqual(rename(true), []);
  assert.deepEqual(rename(false).map(describe), ["rename the community to Test Community"]);
});

test("after_unlink the room is the panel's again: its join rule and topic are put back", async () => {
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomUnlinked);
  assert.equal(actual.rooms.get(GENERAL).topic, "a channel on Discord", "OOYE's unlink writes the channel's topic");
  const ops = planAll(feed({ linked: false, spaceLinked: false }), actual, { mode: "apply" }).ops.filter((o) => o.roomId === GENERAL);
  assert.ok(ops.some((o) => o.op === "setJoinRule"));
  assert.ok(ops.some((o) => o.op === "setTopic" && o.topic === "Say hello"));
  assert.equal(ops.find((o) => o.op === "setPowerLevels").content.notifications.room, 50);
  // The bot left the room; nothing invites it back to an unlinked one.
  assert.ok(!ops.some((o) => o.op === "invite"));
});

test("a Discord thread the bridge opened as a room in the hub is neither listed nor imported", async () => {
  const THREAD = `!thread:${S}`;
  const threadState = [
    { type: "m.room.create", state_key: "", sender: BOT, content: { room_version: "12", additional_creators: [ME] } },
    { type: "m.room.member", state_key: ME, sender: ME, content: { membership: "join" } },
    { type: "m.room.name", state_key: "", sender: BOT, content: { name: "[⛓️] a thread" } },
  ];
  const hubEvents = [...FIX.hubLinked, KIND, { type: "m.space.child", state_key: THREAD, sender: BOT, content: { via: [S] } }];
  const hs = hsOf({ [HUB]: hubEvents, [GENERAL]: FIX.roomLinked, [THREAD]: threadState });
  const hub = await readRoom(hs, HUB, ME);
  const actual = { hub: { roomId: HUB, children: hub.children }, rooms: new Map([[HUB, hub], [GENERAL, await readRoom(hs, GENERAL, ME)], [THREAD, await readRoom(hs, THREAD, ME)]]) };
  const plan = planAll(feed(), actual, { mode: "apply" });
  assert.deepEqual([...plan.ops, ...plan.drift], []);
  assert.deepEqual(planAll(feed(), actual, { mode: "adopt" }).ops, []);
  // A room made by anyone else and linked there is still said.
  actual.rooms.get(THREAD).creators = [`@streamer:${S}`];
  assert.ok(planAll(feed(), actual, { mode: "apply" }).ops.some((o) => o.code === "not_in_panel"));
});

test("the rest OOYE writes on a sync: the server's icon and a wider history", async () => {
  // A Discord server with an icon (OOYE puts it on the hub and on a linked room with no picture of its
  // own) and the "directory" privacy level (history world_readable).
  const ICON = "mxc://bb.test/guildicon";
  const hubEvents = [...FIX.hubLinked, KIND, { type: "m.room.avatar", state_key: "", sender: BOT, content: { url: ICON } }];
  const roomEvents = FIX.roomLinked.map((e) => {
    if (e.type === "m.room.avatar") return { ...e, content: { url: ICON } };
    if (e.type === "m.room.history_visibility") return { ...e, content: { history_visibility: "world_readable" } };
    return e;
  });
  const actual = await actualOf(hubEvents, roomEvents);
  assert.equal(actual.rooms.get(GENERAL).avatar, ICON);
  assert.equal(actual.rooms.get(HUB).avatar, ICON);
  assert.equal(actual.rooms.get(GENERAL).history, "world_readable");
  assert.deepEqual(planAll(feed(), actual, { mode: "apply" }).ops.map(describe), []);
  // Unlinked, every one of them is the panel's again.
  const unlinked = planAll(feed({ linked: false, spaceLinked: false }), actual, { mode: "apply" }).ops;
  for (const k of ["setAvatar", "setHistory"]) assert.ok(unlinked.some((o) => o.op === k && o.roomId === GENERAL), k);
  assert.ok(unlinked.some((o) => o.op === "setAvatar" && o.roomId === HUB));
});

test("a grant the hub still carries never outlives the ladder in a linked room: demoted, banned; the bridge keeps 100", async () => {
  // The bridge copies the hub's grants into every room it links. A mod the site has demoted and an
  // account the site has banned both still hold 50 in the hub (made by hand) and so in #general.
  const EXMOD = `@exmod:${S}`, BANNED = `@_ooye_banned:${S}`;
  const grant = (e) => (e.type === "m.room.power_levels" ? { ...e, content: { ...e.content, users: { ...e.content.users, [EXMOD]: 50, [BANNED]: 50 } } } : e);
  const actual = await actualOf([...FIX.hubLinked, KIND].map(grant), FIX.roomLinked.map(grant));
  const f = feed();
  f.banned = [BANNED];
  const ops = planAll(f, actual, { mode: "apply" }).ops;
  const c = ops.find((o) => o.op === "setPowerLevels" && o.roomId === GENERAL)?.content;
  assert.ok(c, "the stale grants are written out");
  assert.equal(c.users[EXMOD], undefined, "demoted: no power in the linked room");
  assert.equal(c.users[BANNED], undefined, "banned: none either, though its id is in the bridge's namespace");
  assert.equal(c.users[BOT], 100, "the bridge's bot keeps its seat");
  assert.equal(c.users[`@moddy:${S}`], 50);
  // The hub's grant comes back at the bridge's next sync: the run names it, so the admin can remove it there.
  const w = ops.find((o) => o.code === "hub_grant_copied" && o.roomId === GENERAL);
  assert.ok(w);
  assert.deepEqual(w.userIds, [BANNED, EXMOD].sort());
  assert.match(describe(w), /^the community's main space gives @_ooye_banned:bb\.test, @exmod:bb\.test power that the site's roles do not; the Discord bridge copies it into #general/);
  // The next run, with the grants gone from the room (the hub still has them): nothing more to write.
  const after = await actualOf([...FIX.hubLinked, KIND].map(grant), FIX.roomLinked);
  assert.ok(!planAll(f, after, { mode: "apply" }).ops.some((o) => o.op === "setPowerLevels" && o.roomId === GENERAL));
});

test("with the bridge's accounts unknown, a banned account's grant in a linked room still goes", async () => {
  const BANNED = `@mallory:${S}`;
  const grant = (e) => (e.type === "m.room.power_levels" ? { ...e, content: { ...e.content, users: { ...e.content.users, [BANNED]: 50 } } } : e);
  const actual = await actualOf([...FIX.hubLinked, KIND], FIX.roomLinked.map(grant));
  const f = feed();
  f.bridgeUserPatterns = [];
  f.banned = [BANNED];
  const c = planAll(f, actual, { mode: "apply" }).ops.find((o) => o.op === "setPowerLevels" && o.roomId === GENERAL)?.content;
  assert.ok(c, "written");
  assert.equal(c.users[BANNED], undefined);
  assert.equal(c.users[BOT], 100, "the bridge's bot keeps its seat");
  assert.equal(c.users[`@moddy:${S}`], 50, "every other existing grant stays while the accounts are unknown");
  assert.ok(!(ME in c.users), "the service account is a creator here: never listed");
});
