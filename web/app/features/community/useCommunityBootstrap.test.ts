// The community bootstrap's background join, run against a fake homeserver client: which space is
// the hub, and which of its children a member's client joins on its own.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/features/community/useCommunityBootstrap.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { joinCommunity, type HierarchyEntry, type JoinClient } from "../../lib/communityJoin.ts";
import { stripComments } from "../../lib/testSource.ts";

const HUB = "!hub:example.test";
const SERVER = "example.test";
const HUB_ALIAS = "#community-hub:example.test";

type Local = { roomId: string; membership: string; aliases?: string[]; create?: Record<string, unknown>; state?: Record<string, Record<string, unknown>> };

/** A client whose rooms, hierarchy and join outcomes the test sets; every join is recorded in order. */
function fakeClient(opts: { local?: Local[]; hierarchy?: HierarchyEntry[]; refuse?: string[]; hierarchyFails?: boolean } = {}) {
  const local = new Map((opts.local ?? []).map((r) => [r.roomId, { ...r }]));
  const joins: { target: string; via?: string[] }[] = [];
  const room = (r: Local) => ({
    roomId: r.roomId,
    getMyMembership: () => r.membership,
    getCanonicalAlias: () => r.aliases?.[0] ?? null,
    getAltAliases: () => r.aliases?.slice(1) ?? [],
    currentState: {
      getStateEvents: (type: string, key: string) => {
        const content = type === "m.room.create" ? r.create : r.state?.[type];
        return key === "" && content ? { getContent: () => content } : null;
      },
    },
  });
  const client: JoinClient = {
    getRooms: () => [...local.values()].map(room),
    getRoom: (id) => (local.has(id) ? room(local.get(id)!) : null),
    joinRoom: async (target, o) => {
      joins.push({ target, via: o?.viaServers });
      // As a homeserver does: a restricted room refuses a member who is in none of its allowed rooms
      // at the moment they ask; the join itself lands a moment later.
      const entry = opts.hierarchy?.find((e) => e.room_id === target);
      const allowedNow = entry?.join_rule !== "restricted" || (entry.allowed_room_ids ?? []).some((id) => local.get(id)?.membership === "join");
      await Promise.resolve();
      if (!allowedNow || opts.refuse?.includes(target)) throw new Error("M_FORBIDDEN");
      const id = target.startsWith("#") ? HUB : target;
      local.set(id, { roomId: id, membership: "join", ...(id === HUB ? { aliases: [HUB_ALIAS] } : {}) });
      return { roomId: id };
    },
    getRoomHierarchy: async () => {
      if (opts.hierarchyFails) throw new Error("timeout");
      return { rooms: opts.hierarchy ?? [] };
    },
  };
  return { client, joins, local };
}

const hubEntry = (children: string[], content: Record<string, Record<string, unknown>> = {}): HierarchyEntry => ({
  room_id: HUB, room_type: "m.space", join_rule: "public",
  children_state: children.map((c) => ({ state_key: c, content: { via: [SERVER], ...(content[c] ?? {}) } })),
});
const run = (client: JoinClient, hubRoomId: string | null = HUB) =>
  joinCommunity(client, { hubRoomId, hubAlias: HUB_ALIAS, serverName: SERVER, log: { warn: () => {} } });
const joined = (joins: { target: string }[]) => joins.map((j) => j.target);

test("the hub is the room the server names; its alias is only the fallback", async () => {
  const named = fakeClient({ local: [{ roomId: HUB, membership: "join" }], hierarchy: [hubEntry([])] });
  await run(named.client);
  assert.deepEqual(joined(named.joins), [], "already in the named hub: no join at all");

  const unjoined = fakeClient({ hierarchy: [hubEntry([])] });
  await run(unjoined.client);
  assert.deepEqual(unjoined.joins, [{ target: HUB, via: [SERVER] }], "joined by id, through this server");

  const old = fakeClient({ hierarchy: [hubEntry([])] });
  await run(old.client, null);
  assert.deepEqual(joined(old.joins), [HUB_ALIAS], "an older server that names no hub: the alias, as before");
});

test("joins the public and hub-restricted children it is not in", async () => {
  const f = fakeClient({
    local: [{ roomId: HUB, membership: "join" }, { roomId: "!have", membership: "join" }],
    hierarchy: [
      hubEntry(["!pub", "!res", "!have", "!norule"]),
      { room_id: "!pub", join_rule: "public" },
      { room_id: "!res", join_rule: "restricted", allowed_room_ids: [HUB] },
      { room_id: "!have", join_rule: "public" },
      { room_id: "!norule" },
    ],
  });
  await run(f.client);
  assert.deepEqual(joined(f.joins).sort(), ["!norule", "!pub", "!res"], "no join_rule means public (the spec's default); a room already joined is left");
});

test("does not join a restricted room the viewer cannot satisfy", async () => {
  const f = fakeClient({
    local: [{ roomId: HUB, membership: "join" }],
    hierarchy: [
      hubEntry(["!supporters", "!mods", "!invited", "!knock"]),
      { room_id: "!supporters", join_rule: "restricted", allowed_room_ids: ["!gate:example.test"] },
      { room_id: "!mods", join_rule: "invite" },
      { room_id: "!invited", join_rule: "private" },
      { room_id: "!knock", join_rule: "knock" },
    ],
  });
  await run(f.client);
  assert.deepEqual(joined(f.joins), [], "a supporters room (allowed through the gate the viewer is not in), invite-only and knock rooms are never tried");

  const supporter = fakeClient({
    local: [{ roomId: HUB, membership: "join" }, { roomId: "!gate:example.test", membership: "join" }],
    hierarchy: [hubEntry(["!supporters"]), { room_id: "!supporters", join_rule: "restricted", allowed_room_ids: ["!gate:example.test"] }],
  });
  await run(supporter.client);
  assert.deepEqual(joined(supporter.joins), ["!supporters"], "in the gate: the supporters room is joined");
});

test("a room restricted through a category is joined after the category", async () => {
  const f = fakeClient({
    local: [{ roomId: HUB, membership: "join" }],
    hierarchy: [
      hubEntry(["!cat"]),
      { room_id: "!cat", room_type: "m.space", join_rule: "restricted", allowed_room_ids: [HUB],
        children_state: [{ state_key: "!inner", content: { via: [SERVER] } }] },
      { room_id: "!inner", join_rule: "restricted", allowed_room_ids: ["!cat"] },
    ],
  });
  await run(f.client);
  assert.deepEqual(joined(f.joins), ["!cat", "!inner"]);
  assert.equal(f.local.get("!inner")?.membership, "join", "asked only once the category was joined, so the server let it in");
});

test("does not join a gate space", async () => {
  const f = fakeClient({
    local: [
      { roomId: HUB, membership: "join" },
      { roomId: "!known-gate", membership: "invite", create: { type: "m.space", "app.blackbranch.space_kind": "gate" } },
      { roomId: "!state-gate", membership: "invite", create: { type: "m.space" }, state: { "app.blackbranch.space_kind": { kind: "gate" } } },
    ],
    hierarchy: [
      hubEntry(["!gate-a", "!gate-b", "!known-gate", "!state-gate", "!cat"], { "!gate-b": { "app.blackbranch.space_kind": "gate" } }),
      // Marked in the entry itself, through the parent's link, and in the room's own create content.
      { room_id: "!gate-a", room_type: "m.space", join_rule: "public", "app.blackbranch.space_kind": "gate" } as HierarchyEntry,
      { room_id: "!gate-b", room_type: "m.space", join_rule: "restricted", allowed_room_ids: [HUB] },
      { room_id: "!known-gate", room_type: "m.space", join_rule: "public" },
      // Marked only by the space_kind state event the reconciler writes ({ kind: "gate" }).
      { room_id: "!state-gate", room_type: "m.space", join_rule: "public" },
      { room_id: "!cat", room_type: "m.space", join_rule: "restricted", allowed_room_ids: [HUB] },
    ],
  });
  await run(f.client);
  assert.deepEqual(joined(f.joins), ["!cat"], "a gate space is never joined by the client, however it is reachable; an ordinary category is");
});

test("retry: a refused join is logged and the rest still join; the next pass tries it again", async () => {
  const hierarchy = [hubEntry(["!a", "!b"]), { room_id: "!a", join_rule: "public" }, { room_id: "!b", join_rule: "public" }];
  const f = fakeClient({ local: [{ roomId: HUB, membership: "join" }], hierarchy, refuse: ["!a"] });
  await run(f.client);
  assert.deepEqual(joined(f.joins).sort(), ["!a", "!b"]);
  assert.equal(f.local.get("!b")?.membership, "join");
  f.joins.length = 0;
  await run(f.client);
  assert.deepEqual(joined(f.joins), ["!a"], "only the room still missing is tried again");
});

test("restart: a second pass after everything joined joins nothing", async () => {
  const hierarchy = [hubEntry(["!a"]), { room_id: "!a", join_rule: "public" }];
  const f = fakeClient({ hierarchy });
  await run(f.client);
  f.joins.length = 0;
  await run(f.client);
  assert.deepEqual(f.joins, []);
});

test("a hierarchy that cannot be read joins nothing and does not throw", async () => {
  const f = fakeClient({ local: [{ roomId: HUB, membership: "join" }], hierarchyFails: true });
  await run(f.client);
  assert.deepEqual(f.joins, []);
});

test("the hook joins through joinCommunity with the hub the server names", () => {
  const src = stripComments(readFileSync(join(import.meta.dirname, "useCommunityBootstrap.ts"), "utf8"));
  assert.match(src, /hubRoomId: \(await fetchCommunityAnswer\(\)\)\?\.hubRoomId \?\? null/);
  assert.match(src, /await joinCommunity\(client, \{/);
  assert.match(src, /return \{ rooms, invites \};\s*\}\s*$/, "vacuity anchor: the hook's last line");
  assert.doesNotMatch(src, /getRoomHierarchy/, "the hook has no join loop of its own");
});
