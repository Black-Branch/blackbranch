// Which channels need which site mods granted power, and — just as important —
// which need nothing written at all.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/modPowerPlan.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { modPowerPlan, modDemotePlan, type PlanRoom } from "./modPowerPlan.ts";

const OWNER = "@casey:site.test";
const MODS = ["@rosalind:site.test", "@quinn:site.test", OWNER];

function room(roomId: string, powers: Record<string, number>, writable = true): PlanRoom {
  return {
    roomId,
    currentState: { maySendStateEvent: () => writable },
    getMember: (id: string) => (powers[id] === undefined ? null : { powerLevel: powers[id]! }),
  };
}

test("a mod with no power is granted it", () => {
  const plan = modPowerPlan([room("!a", { "@rosalind:site.test": 0, "@quinn:site.test": 0 })], MODS, OWNER);
  assert.deepEqual(plan, [{ roomId: "!a", userIds: ["@rosalind:site.test", "@quinn:site.test"] }]);
});

test("a mod who is not a member of the room is still granted power", () => {
  // A power_levels entry does not require membership, and granting it up front
  // means the mod can act the moment they join.
  const plan = modPowerPlan([room("!a", {})], ["@rosalind:site.test"], OWNER);
  assert.deepEqual(plan, [{ roomId: "!a", userIds: ["@rosalind:site.test"] }]);
});

test("a settled server produces NO writes at all", () => {
  const settled = room("!a", { "@rosalind:site.test": 50, "@quinn:site.test": 50 });
  assert.deepEqual(modPowerPlan([settled], MODS, OWNER), []);
});

test("a mod already above 50 is left alone — this never demotes", () => {
  const plan = modPowerPlan(
    [room("!a", { "@rosalind:site.test": 100, "@quinn:site.test": 0 })],
    MODS, OWNER
  );
  assert.deepEqual(plan, [{ roomId: "!a", userIds: ["@quinn:site.test"] }]);
});

test("the viewer is never written into the map", () => {
  // The owner's power comes from creating the room (v12 gives a creator
  // Infinity and no `users` entry) — never a literal number this plan could
  // write. If the viewer-exclusion filter were ever dropped, the owner would
  // fall through to `getMember(OWNER) ?? 0` — absent from the map, like any
  // v12 creator, so read as power 0 — and get "granted" a literal 50 here.
  // That replaces implicit UNLIMITED power with a number, and it could never
  // be undone from the client afterwards, because undoing it needs the power
  // it just gave away.
  //
  // Isolates the filter: the other mod is already settled AT the level, so
  // the never-demote filter removes them on its own, leaving the owner as
  // the only thing that could still produce a plan entry. A correct
  // implementation excludes the owner too, so the room fixture's absence of
  // an OWNER entry is never even reached.
  const plan = modPowerPlan(
    [room("!a", { "@rosalind:site.test": 50 })],
    [OWNER, "@rosalind:site.test"],
    OWNER
  );
  assert.deepEqual(plan, []);
});

test("a room the viewer cannot write power levels in is skipped", () => {
  const plan = modPowerPlan([room("!a", { "@rosalind:site.test": 0 }, false)], MODS, OWNER);
  assert.deepEqual(plan, []);
});

test("only the rooms needing a write appear", () => {
  const plan = modPowerPlan(
    [room("!a", { "@rosalind:site.test": 50 }), room("!b", { "@rosalind:site.test": 0 })],
    ["@rosalind:site.test"], OWNER
  );
  assert.deepEqual(plan.map((p) => p.roomId), ["!b"]);
});

// ── Taking power back from a former mod (modDemotePlan) ──────────────────────

function listedRoom(roomId: string, listed: Record<string, number>, members: Record<string, number> = {}, writable = true) {
  return {
    roomId,
    currentState: {
      maySendStateEvent: () => writable,
      getStateEvents: () => ({ getContent: () => ({ users: listed }) }),
    },
    getMember: (id: string) => (members[id] === undefined ? null : { powerLevel: members[id]! }),
  };
}

test("anyone listed at 50 who is not a site mod loses it — however the role was lost, with no log row needed", () => {
  // @rosalind's is_mod was cleared by a path that wrote nothing to the mod log: still stripped,
  // in a room she never joined (power is granted up front) and in one she did.
  const plan = modDemotePlan(
    [listedRoom("!a", { "@rosalind:site.test": 50, [OWNER]: 100 }), listedRoom("!b", { "@rosalind:site.test": 50 }, { "@rosalind:site.test": 50 })],
    [OWNER, "@quinn:site.test"], OWNER);
  assert.deepEqual(plan, [{ roomId: "!a", userIds: ["@rosalind:site.test"] }, { roomId: "!b", userIds: ["@rosalind:site.test"] }]);
});

test("a current mod is never stripped; neither is a hand-set level above 50, the viewer, or an unwritable room", () => {
  assert.deepEqual(modDemotePlan([listedRoom("!a", { "@quinn:site.test": 50 })], ["@quinn:site.test"], OWNER), []);
  assert.deepEqual(modDemotePlan([listedRoom("!a", { "@rosalind:site.test": 100 })], [], OWNER), []);
  assert.deepEqual(modDemotePlan([listedRoom("!a", { [OWNER]: 50 })], [], OWNER), []);
  assert.deepEqual(modDemotePlan([listedRoom("!a", { "@rosalind:site.test": 50 }, {}, false)], [], OWNER), []);
});

// ── Bridge bots and the install's own accounts keep their power ────────────────────────────
// On another install a managed room holds a bridge bot (mautrix-discord) or the install's bot at
// mod level: neither is a site mod, and stripping them broke the bridge. Exempt by what the install
// and the room SAY — the staff accounts (streamer, bot, extras) and every bridge bot a bridged
// room names in its m.bridge / uk.half-shot.bridge state — never by a name in the code.
function bridgedRoom(roomId: string, listed: Record<string, number>, bridges: Record<string, { bridgebot?: unknown; sender?: string }[]>) {
  return {
    roomId,
    currentState: {
      maySendStateEvent: () => true,
      getStateEvents: (type: string, stateKey?: string) => stateKey === undefined
        ? (bridges[type] ?? []).map(({ sender, ...c }) => ({ getContent: () => c, getSender: () => sender ?? ADMIN100 }))
        : ({ getContent: () => ({ users: listed }) }),
    },
    getMember: () => null,
  };
}

const ADMIN100 = "@admin100:site.test";

test("a bridge bot the room names, and the install's staff accounts, keep mod-level power", () => {
  const BRIDGE = "@relaybot:site.test", HALF = "@oldbridge:site.test", BOT = "@helper:site.test", GONE = "@rosalind:site.test";
  const room = bridgedRoom("!a", { [BRIDGE]: 50, [HALF]: 50, [BOT]: 50, [GONE]: 50, [ADMIN100]: 100 }, {
    "m.bridge": [{ bridgebot: BRIDGE }],
    "uk.half-shot.bridge": [{ bridgebot: HALF }, { bridgebot: 7 }],
  });
  assert.deepEqual(modDemotePlan([room], [OWNER], OWNER, 50, [BOT]), [{ roomId: "!a", userIds: [GONE] }]);
  // Without the room's bridge state and the staff list, all four would go: the exemption is the data.
  const bare = bridgedRoom("!a", { [BRIDGE]: 50, [HALF]: 50, [BOT]: 50, [GONE]: 50, [ADMIN100]: 100 }, {});
  assert.deepEqual(modDemotePlan([bare], [OWNER], OWNER), [{ roomId: "!a", userIds: [BRIDGE, HALF, BOT, GONE] }]);
});

test("the plan's caller hands it the install's staff accounts from the mods answer", () => {
  const raw = readFileSync(join(process.cwd(), "app/lib/useModPowerSync.ts"), "utf8");
  assert.match(raw, /\n\}\n?$/, "END not read");
  assert.match(raw, /modDemotePlan\(rooms, modIds, myUserId, MOD_POWER, keepIds\)/);
  const route = readFileSync(join(process.cwd(), "app/api/community/mods/route.ts"), "utf8");
  assert.match(route, /keepIds: \[\.\.\.staffMatrixIds\(\)\]/);
});

test("a bridge event counts only from a sender ABOVE mod level (or a staff account): a mod cannot plant one to keep power", () => {
  const MOD = "@leaving:site.test", BRIDGE = "@relaybot:site.test", BOT = "@helper:site.test";
  // A mod about to lose the role writes a bridge event naming themselves: still demoted.
  const planted = bridgedRoom("!a", { [MOD]: 50, [ADMIN100]: 100 }, { "m.bridge": [{ bridgebot: MOD, sender: MOD }] });
  assert.deepEqual(modDemotePlan([planted], [OWNER], OWNER), [{ roomId: "!a", userIds: [MOD] }]);
  // Naming a real bridge bot from a mod-level sender counts for nothing either.
  const byMod = bridgedRoom("!a", { [MOD]: 50, [BRIDGE]: 50, [ADMIN100]: 100 }, { "m.bridge": [{ bridgebot: BRIDGE, sender: MOD }] });
  assert.deepEqual(modDemotePlan([byMod], [OWNER], OWNER), [{ roomId: "!a", userIds: [MOD, BRIDGE] }]);
  // The same event sent by a 100-level account: the named bot is kept.
  const byAdmin = bridgedRoom("!a", { [MOD]: 50, [BRIDGE]: 50, [ADMIN100]: 100 }, { "m.bridge": [{ bridgebot: BRIDGE, sender: ADMIN100 }] });
  assert.deepEqual(modDemotePlan([byAdmin], [OWNER], OWNER), [{ roomId: "!a", userIds: [MOD] }]);
  // A staff account's event counts even at mod level.
  const byStaff = bridgedRoom("!a", { [BOT]: 50, [BRIDGE]: 50 }, { "m.bridge": [{ bridgebot: BRIDGE, sender: BOT }] });
  assert.deepEqual(modDemotePlan([byStaff], [OWNER], OWNER, 50, [BOT]), []);
});
