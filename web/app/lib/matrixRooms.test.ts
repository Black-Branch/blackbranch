// Space-tree shape: the rules that decide where a room appears in the rail.
//
// These are the three ways the nav model can go wrong in a way a user actually
// sees: a room drawn twice, a link that should have been removed still counting,
// and a space cycle taking the tab down. All three are reachable from ordinary
// Element actions, so none of them are theoretical.
//
// Run: node --test app/lib/matrixRooms.test.ts

import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpaceNode, getSpaceChildren, allChannelsInNode, isForumRoom } from "./matrixRooms.ts";

type Ev = { getStateKey: () => string; getContent: () => { via?: unknown } };

/** Duck-typed stand-in for the SDK's Room — only the surface these helpers touch. */
function room(roomId: string, opts: { space?: boolean; children?: string[]; parents?: string[]; noVia?: boolean; name?: string; order?: Record<string, unknown> } = {}) {
  const mk = (ids: string[]): Ev[] =>
    ids.map((id) => ({
      getStateKey: () => id,
      getContent: () => (opts.noVia ? {} : { via: ["site.test"], ...(opts.order && id in opts.order ? { order: opts.order[id] } : {}) }),
    }));
  return {
    roomId,
    name: opts.name ?? roomId,
    getType: () => (opts.space ? "m.space" : null),
    currentState: {
      // The SDK's shape: no key → every event of the type; a key → that one event or null.
      getStateEvents: (type: string, key?: string) => {
        const list = type === "m.space.child" ? mk(opts.children ?? []) : type === "m.space.parent" ? mk(opts.parents ?? []) : [];
        return key === undefined ? list : list.find((e) => e.getStateKey() === key) ?? null;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double: this stands in for a Matrix SDK Room, of which the code under test uses four members. Typing the mock as Room would demand the whole (large, SDK-owned) interface, and the compiler error that cast hides is the one the test is deliberately taking on
  } as any;
}

test("a room nested in a sub-space is NOT also listed at the parent level", () => {
  // Adding a room to a space does not remove its other parents: with Community
  // Hub > Discord > {General, Politics, Tech} and the three ALSO direct
  // children of the Hub, a column that draws each parent's children would draw
  // them twice, which reads as a bug rather than as "this room is in two
  // spaces".
  const tech = room("!tech");
  const discord = room("!discord", { space: true, children: ["!tech"] });
  const hub = room("!hub", { space: true, children: ["!discord", "!tech"] });

  const node = buildSpaceNode(hub, [hub, discord, tech]);
  assert.deepEqual(node.channels.map((r) => r.roomId), [], "the deeper home wins — no copy at hub level");
  assert.deepEqual(node.subSpaces[0]!.channels.map((r) => r.roomId), ["!tech"]);
  // Still reachable exactly once overall — deduping must not hide the room.
  assert.deepEqual(allChannelsInNode(node).map((r) => r.roomId), ["!tech"]);
});

test("a room directly in a space and nowhere deeper still shows at that level", () => {
  const general = room("!general");
  const hub = room("!hub", { space: true, children: ["!general"] });
  const node = buildSpaceNode(hub, [hub, general]);
  assert.deepEqual(node.channels.map((r) => r.roomId), ["!general"]);
});

test("a space cycle terminates instead of hanging the tab", () => {
  // Matrix does not forbid putting A inside B and B inside A, and Element will
  // create it. Unguarded recursion here never returns.
  const a = room("!a", { space: true, children: ["!b"] });
  const b = room("!b", { space: true, children: ["!a"] });
  const node = buildSpaceNode(a, [a, b]);
  assert.equal(node.subSpaces.length, 1, "B is reached once");
  assert.equal(node.subSpaces[0]!.subSpaces.length, 0, "and does not re-descend into A");
});

test("a link with no `via` is not a link — in BOTH directions", () => {
  // An empty/absent `via` is how the spec REMOVES a space link. Honouring it on
  // m.space.child but not m.space.parent let a removed child come back.
  const orphan = room("!orphan", { parents: ["!hub"], noVia: true });
  const hub = room("!hub", { space: true, children: ["!orphan"], noVia: true });
  assert.deepEqual(getSpaceChildren(hub, [hub, orphan]), [], "neither direction may resurrect it");

  const joined = room("!joined", { parents: ["!hub2"] });
  const hub2 = room("!hub2", { space: true });
  assert.deepEqual(
    getSpaceChildren(hub2, [hub2, joined]).map((r) => r.roomId),
    ["!joined"],
    "a parent link WITH via still counts, even with no matching child event"
  );
});

test("children sort by order then name", () => {
  // The space's own m.space.child `order` decides (the reconciler writes it from the panel's order);
  // children without a usable order follow, by name. An order outside the spec's shape (not a
  // string, longer than 50, or outside printable ASCII) counts as none.
  const kids = {
    "!b": room("!b", { name: "Bravo" }),
    "!a": room("!a", { name: "alpha" }),
    "!z": room("!z", { name: "Zulu" }),
    "!y": room("!y", { name: "Yankee" }),
    "!bad": room("!bad", { name: "Charlie" }),
    "!long": room("!long", { name: "Delta" }),
    "!cat2": room("!cat2", { space: true, name: "Second" }),
    "!cat1": room("!cat1", { space: true, name: "First" }),
  };
  const hub = room("!hub", {
    space: true,
    children: Object.keys(kids),
    order: { "!z": "a0", "!y": "a1", "!bad": 7, "!long": "x".repeat(51), "!cat2": "a0", "!cat1": "a1" },
  });
  const node = buildSpaceNode(hub, [hub, ...Object.values(kids)]);
  assert.deepEqual(node.channels.map((r) => r.roomId), ["!z", "!y", "!a", "!b", "!bad", "!long"],
    "ordered first by the order string, then the rest by name (case-insensitive)");
  assert.deepEqual(node.subSpaces.map((n) => n.space.roomId), ["!cat2", "!cat1"], "categories follow the order too, not their names");
});

test("restart: the same rooms in another arrival order give the same column", () => {
  // A reload hands getRooms() back in whatever order sync filled the store; the column must not move.
  const a = room("!a", { name: "alpha" }), b = room("!b", { name: "bravo" }), c = room("!c", { name: "charlie" });
  const hub = room("!hub", { space: true, children: ["!a", "!b", "!c"], order: { "!c": "m" } });
  const first = buildSpaceNode(hub, [hub, a, b, c]).channels.map((r) => r.roomId);
  const again = buildSpaceNode(hub, [c, b, hub, a]).channels.map((r) => r.roomId);
  assert.deepEqual(first, ["!c", "!a", "!b"]);
  assert.deepEqual(again, first);
});

// ── isForumRoom: the forum flag under either namespace ────────────────────────────────────────
function flagged(state: Record<string, Record<string, unknown>>) {
  return {
    roomId: "!r",
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        if (key === undefined) return [];
        const c = state[type];
        return c ? { getContent: () => c } : null;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double: a Room with only currentState.getStateEvents, which is all isForumRoom reads
  } as any;
}

test("isForumRoom: the legacy flag still marks a forum", () => {
  assert.equal(isForumRoom(flagged({ "net.prior.room_type": { type: "forum" } })), true);
});

test("isForumRoom: the product flag marks a forum", () => {
  assert.equal(isForumRoom(flagged({ "app.blackbranch.room_type": { type: "forum" } })), true);
});

test("isForumRoom: the product flag wins over the legacy one; a cleared product flag ({}) falls back", () => {
  assert.equal(isForumRoom(flagged({ "app.blackbranch.room_type": { type: "chat" }, "net.prior.room_type": { type: "forum" } })), false);
  assert.equal(isForumRoom(flagged({ "app.blackbranch.room_type": {}, "net.prior.room_type": { type: "forum" } })), true);
  assert.equal(isForumRoom(flagged({})), false);
});

// ── The flag is the only thing that makes a forum ─────────────────────────────────────────────
function parented(state: Record<string, Record<string, unknown>>, parentSpace: string) {
  const parent = { getStateKey: () => parentSpace, getContent: () => ({ via: ["example.tv"] }) };
  return {
    roomId: "!r",
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        if (key === undefined) return type === "m.space.parent" ? [parent] : [];
        const c = state[type];
        return c ? { getContent: () => c } : null;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double: a Room with only currentState.getStateEvents, which is all isForumRoom reads
  } as any;
}

test("isForumRoom: a live parent link to a space does not make a forum; the flag does", () => {
  assert.equal(isForumRoom(parented({}, "!forums:example.tv")), false);
  assert.equal(isForumRoom(parented({ "app.blackbranch.room_type": { type: "forum" } }, "!forums:example.tv")), true);
});

test("no forum space id lives in the community client (no FORUM_SPACE_IDS)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./matrixRooms.ts", import.meta.url), "utf8");
  // END anchor: the file's last export was read, so the negative assertions below are not vacuous.
  assert.match(src, /export function favouriteRooms\(rooms: Room\[\]\): Room\[\] \{[\s\S]*\}\s*$/);
  assert.doesNotMatch(src, /FORUM_SPACE_IDS|!lembZf8h/);
  assert.match(src, /readFirst\(ROOM_TYPE,/, "the namespaced flag is how a forum is recognised");
});

test("buildNav lists no DM room — the DM list shows conversations, one per person (Task 20)", async () => {
  const { buildNav } = await import("./matrixRooms.ts");
  const dm = Object.assign(room("!dm"), {
    getDMInviter: () => "@robin:site.test",
    getMembers: () => [{ userId: "@me:site.test", membership: "join" }, { userId: "@robin:site.test", membership: "join" }],
  });
  const lobby = Object.assign(room("!lobby"), { getDMInviter: () => undefined, getMembers: () => [] });
  const nav = buildNav([dm, lobby], "@me:site.test", new Set());
  assert.deepEqual(nav.orphanChannels.map((r: { roomId: string }) => r.roomId), ["!lobby"], "a DM is not a channel");
  assert.deepEqual(Object.keys(nav).sort(), ["orphanChannels", "spaceTree"], "no per-room DM list");
});
