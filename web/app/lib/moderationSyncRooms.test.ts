// Site moderation reaches community rooms only. The browser's moderation writers (mod power levels,
// the site-ban sync) were handed the OPEN room when no community server was active — in DM Home that
// is a private DM — and wrote "Banned on the site" notices and moderator power levels into people's
// DMs (dm-crypto-research B.5). They now get moderationSyncRooms: the rooms the hub ITSELF lists
// (its own m.space.child state, through sub-spaces the hub's admins run), minus any strict DM.
// Also: a DM's "partner" is the person in it, never a banned third row.
// Run: node --test app/lib/moderationSyncRooms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNav, buildServers, COMMUNITY_HUB_ALIAS, dmPartner, moderationSyncRooms } from "./matrixRooms.ts";

const ME = "@mod:site.test";
const ADMIN = "@admin:site.test";
type Member = { userId: string; membership: string; direct?: boolean };

/** A duck-typed Room. `children` are this space's own m.space.child events (sent by `childSender`,
 *  ADMIN by default); `childWriters` may send m.space.child here (ADMIN by default); `parents` are
 *  the room's own m.space.parent claims. Channels are public unless `joinRule` says otherwise. */
function room(roomId: string, opts: {
  space?: boolean; children?: string[]; parents?: string[]; childSender?: string; childWriters?: string[];
  /** per-link senders, overriding childSender */ senders?: Record<string, string>;
  alias?: string; members?: Member[]; inviter?: string; joinRule?: string; noPowerLevels?: boolean;
  /** the create event: its sender and room version */ creator?: string; roomVersion?: string;
} = {}) {
  const ev = (id: string, sender: string) => ({ getStateKey: () => id, getSender: () => sender, getContent: () => ({ via: ["site.test"] }) });
  const kids = (opts.children ?? []).map((id) => ev(id, opts.senders?.[id] ?? opts.childSender ?? ADMIN));
  const parents = (opts.parents ?? []).map((id) => ev(id, "@anyone:site.test"));
  const writers = opts.childWriters ?? [ADMIN];
  // Power levels as the server keeps them: whoever may write child links sits at 100.
  const pl = { getContent: () => ({ users: Object.fromEntries(writers.map((a) => [a, 100])), events: { "m.space.child": 100 }, users_default: 0 }) };
  const members = opts.members ?? [];
  const count = (m: string) => members.filter((x) => x.membership === m).length;
  return {
    roomId,
    name: roomId,
    getType: () => (opts.space ? "m.space" : null),
    getMyMembership: () => "join",
    getCanonicalAlias: () => opts.alias ?? null,
    getAltAliases: () => [],
    getDMInviter: () => opts.inviter,
    getMembers: () => members,
    getMember: (id: string) => {
      const m = members.find((x) => x.userId === id);
      return m ? { ...m, events: { member: { getContent: () => ({ membership: m.membership, ...(m.direct ? { is_direct: true } : {}) }) } } } : null;
    },
    getJoinedMemberCount: () => count("join"),
    getInvitedMemberCount: () => count("invite"),
    getJoinRule: () => opts.joinRule ?? "public",
    getHistoryVisibility: () => "shared",
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        if (type === "m.room.power_levels") return opts.noPowerLevels ? null : pl;
        if (type === "m.room.create") return opts.creator ? { getSender: () => opts.creator, getContent: () => ({ room_version: opts.roomVersion ?? "10" }) } : null;
        const list = type === "m.space.child" ? kids : type === "m.space.parent" ? parents : [];
        return key === undefined ? list : list.find((e) => e.getStateKey() === key) ?? null;
      },
      maySendStateEvent: (_type: string, userId: string) => writers.includes(userId),
    },
  } as never;
}

const ids = (rs: { roomId: string }[]) => rs.map((r) => r.roomId).sort();
const scope = (rooms: never[], dmIds = new Set<string>()) => {
  const s = buildServers(buildNav(rooms, ME, dmIds)).find((x) => x.id === "!hub") ?? null;
  return ids(moderationSyncRooms(s, rooms, ME, dmIds));
};

const general = room("!general");
const politics = room("!politics");
const category = room("!discord", { space: true, children: ["!politics"] });
const hub = room("!hub", { space: true, children: ["!general", "!discord"], alias: COMMUNITY_HUB_ALIAS });

test("the hub's server: the rooms the hub lists, through the sub-spaces its admins run", () => {
  assert.deepEqual(scope([hub, general, category, politics]), ["!general", "!politics"]);
});

test("a room claiming the hub as its parent is NOT moderated (a parent claim is the room owner's word)", () => {
  const claim = room("!private", { parents: ["!hub"] });
  const rooms = [hub, general, category, politics, claim];
  const s = buildServers(buildNav(rooms, ME, new Set())).find((x) => x.id === "!hub")!;
  assert.ok(s.channels.some((r) => r.roomId === "!private"), "fixture: the rail does show it under the hub");
  assert.deepEqual(scope(rooms), ["!general", "!politics"]);
});

test("a child link written by someone without the power to write it does not count", () => {
  // Every link in this hub was sent by a user the hub does not let write links.
  const trollLinked = room("!hub", {
    space: true, children: ["!general", "!forged"], alias: COMMUNITY_HUB_ALIAS, childSender: "@troll:site.test",
  });
  assert.deepEqual(scope([trollLinked, general, room("!forged")]), [], "links by a sender without power count for nothing");
  assert.deepEqual(scope([hub, general, category, politics]), ["!general", "!politics"], "the same rooms, linked by an admin");
});

test("a linked sub-space the hub's admins do not run contributes nothing", () => {
  // A member made a space, linked it under the hub, and lists a room of theirs in it.
  const theirs = room("!theirs");
  const memberSpace = room("!memberspace", { space: true, children: ["!theirs"], childSender: "@member:site.test", childWriters: ["@member:site.test"] });
  const hub3 = room("!hub", { space: true, children: ["!general", "!memberspace"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub3, general, memberSpace, theirs]), ["!general"]);
});

test("a sub-space WRITABLE by a hub admin but not controlled by the hub: only the admin's own links count", () => {
  const mine = room("!mine");
  const curated = room("!curated");
  const shared = room("!shared", {
    space: true, children: ["!mine", "!curated"], childWriters: [ADMIN, "@member:site.test"],
    senders: { "!mine": "@member:site.test", "!curated": ADMIN },
  });
  const hub6 = room("!hub", { space: true, children: ["!general", "!shared"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub6, general, shared, mine, curated]), ["!curated", "!general"]);
});

test("a room marked is_direct only by the PARTNER is still moderated (the fence trusts only our own marks)", () => {
  const theirMark = room("!theirmark", { joinRule: "invite", members: [{ userId: ME, membership: "join" }, { userId: "@kid:site.test", membership: "join", direct: true }] });
  const hub7 = room("!hub", { space: true, children: ["!general", "!theirmark"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub7, general, theirMark]), ["!general", "!theirmark"]);
});

test("the hub's creator counts as a hub admin in room version 12 (not in older versions)", () => {
  const STREAMER = "@streamer:site.test";
  const handLinked = room("!handlinked");
  const category2 = room("!cat", { space: true, children: ["!handlinked"], childSender: STREAMER, childWriters: [STREAMER] });
  const v12 = room("!hub", { space: true, children: ["!general", "!cat"], alias: COMMUNITY_HUB_ALIAS, creator: STREAMER, roomVersion: "12" });
  assert.deepEqual(scope([v12, general, category2, handLinked]), ["!general", "!handlinked"], "the streamer's own link in a category counts");
  const v10 = room("!hub", { space: true, children: ["!general", "!cat"], alias: COMMUNITY_HUB_ALIAS, creator: STREAMER, roomVersion: "10" });
  assert.deepEqual(scope([v10, general, category2, handLinked]), ["!general"], "a v10 creator has no standing power");
});

test("a strict DM in OUR m.direct, linked into the hub, is still never moderated (the second fence)", () => {
  const dm = room("!dm", { joinRule: "invite", members: [{ userId: ME, membership: "join", direct: true }, { userId: "@kid:site.test", membership: "join" }] });
  const hub4 = room("!hub", { space: true, children: ["!general", "!dm"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub4, general, dm], new Set(["!dm"])), ["!general"]);
  // Not in our m.direct: an is_direct mark on our member event (written by whoever invited us) is
  // not our filing, so the fence does not apply.
  assert.deepEqual(scope([hub4, general, dm]), ["!dm", "!general"]);
});

test("a link in a sub-space sent by a non-admin contributes nothing, even with no power_levels event", () => {
  const theirs = room("!theirs");
  const bare = room("!bare", { space: true, children: ["!theirs"], childSender: "@member:site.test", childWriters: ["@member:site.test"], noPowerLevels: true });
  const hub8 = room("!hub", { space: true, children: ["!general", "!bare"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub8, general, bare, theirs]), ["!general"]);
});

test("a hub room flagged is_direct by a stranger (and in m.direct) is still moderated: not a strict DM", () => {
  const flagged = room("!politics", { inviter: "@stranger:site.test", members: [{ userId: ME, membership: "join", direct: true }, { userId: "@stranger:site.test", membership: "join" }] });
  const hub5 = room("!hub", { space: true, children: ["!general", "!politics"], alias: COMMUNITY_HUB_ALIAS });
  assert.deepEqual(scope([hub5, general, flagged], new Set(["!politics"])), ["!general", "!politics"], "a public channel is no private conversation");
});

test("DM Home (no server) — the open DM gets nothing written into it", () => {
  assert.deepEqual(moderationSyncRooms(null, [hub, general], ME, new Set()), []);
});

test("rooms outside the hub get nothing: the orphan-room server, another space", () => {
  const theirs = room("!theirs");
  const other = room("!otherspace", { space: true, children: ["!theirs"] });
  const mine = room("!mine");
  const rooms = [hub, general, other, theirs, mine];
  const servers = buildServers(buildNav(rooms, ME, new Set()));
  const main = servers.find((s) => s.room === null) ?? null;
  assert.ok(main, "the orphan-room server exists in this fixture");
  assert.deepEqual(moderationSyncRooms(main, rooms, ME, new Set()), []);
  assert.deepEqual(moderationSyncRooms(servers.find((s) => s.id === "!otherspace") ?? null, rooms, ME, new Set()), []);
});

test("no hub joined: nothing at all", () => {
  const theirs = room("!theirs");
  const other = room("!otherspace", { space: true, children: ["!theirs"] });
  const rooms = [general, other, theirs];
  assert.deepEqual(moderationSyncRooms(buildServers(buildNav(rooms, ME, new Set()))[0] ?? null, rooms, ME, new Set()), []);
});

test("a DM's partner is the person in it, never a banned third row; one who left is still the partner", () => {
  const banned = room("!d1", { members: [{ userId: "@troll:site.test", membership: "ban" }, { userId: ME, membership: "join" }, { userId: "@kid:site.test", membership: "join" }] });
  assert.equal(dmPartner(banned, ME, new Set(["!d1"]))?.userId, "@kid:site.test");
  const left = room("!d2", { members: [{ userId: "@troll:site.test", membership: "ban" }, { userId: ME, membership: "join" }, { userId: "@kid:site.test", membership: "leave" }] });
  assert.equal(dmPartner(left, ME, new Set(["!d2"]))?.userId, "@kid:site.test");
});
