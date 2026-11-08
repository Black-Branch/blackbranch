// A site ban reaches the community rooms and DMs. The rooms are reconciled from a mod's own client
// (the Matrix client is mocked at its call boundary: ban / unban); a banned account cannot start a
// DM through the site.
// Run: node --test app/lib/siteBanSync.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";
import { siteBanPlan, runSiteBanPlan, activeSiteBans, SITE_BAN_REASON, type BanSyncRoom } from "./siteBanSync.ts";
import { stripComments } from "./testSource.ts";

const MOD = "@mod:site.test";
const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

type M = { pl?: number; membership?: string; reason?: string };
function room(roomId: string, members: Record<string, M>, banLevel = 50): BanSyncRoom {
  const member = (id: string) => {
    const m = members[id];
    return m ? { userId: id, powerLevel: m.pl ?? 0, membership: m.membership ?? "join", events: { member: { getContent: () => ({ reason: m.reason }) } } } : null;
  };
  return {
    roomId,
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= banLevel },
    getMember: member,
    getMembersWithMembership: () => Object.keys(members).filter((id) => members[id]!.membership === "ban").map((id) => member(id)!),
  };
}

test("a site-banned account is banned in every room the mod can ban in — also one they never joined", () => {
  const plan = siteBanPlan([room("!a", { [MOD]: { pl: 50 }, "@casey:site.test": {} }), room("!b", { [MOD]: { pl: 50 } })], ["@casey:site.test"], MOD, true);
  assert.deepEqual(plan, [{ roomId: "!a", ban: ["@casey:site.test"], unban: [] }, { roomId: "!b", ban: ["@casey:site.test"], unban: [] }]);
});

test("already banned, no ban power, the mod themselves, or someone at the mod's own power: nothing", () => {
  assert.deepEqual(siteBanPlan([room("!a", { [MOD]: { pl: 50 }, "@casey:site.test": { membership: "ban", reason: SITE_BAN_REASON } })], ["@casey:site.test"], MOD, true), []);
  assert.deepEqual(siteBanPlan([room("!a", { [MOD]: { pl: 0 } })], ["@casey:site.test"], MOD, true), []);
  assert.deepEqual(siteBanPlan([room("!a", { [MOD]: { pl: 50 } })], [MOD], MOD, true), []);
  assert.deepEqual(siteBanPlan([room("!a", { [MOD]: { pl: 50 }, "@other:site.test": { pl: 50 } })], ["@other:site.test"], MOD, true), []);
});

test("when the site ban ends the room ban this sync made is lifted; a ban a mod made by hand stays", () => {
  const plan = siteBanPlan([room("!a", {
    [MOD]: { pl: 50 },
    "@casey:site.test": { membership: "ban", reason: SITE_BAN_REASON },
    "@troll:site.test": { membership: "ban", reason: "spam in #general" },
  })], [], MOD, true);
  assert.deepEqual(plan, [{ roomId: "!a", ban: [], unban: ["@casey:site.test"] }]);
});

test("the plan reaches the client as ban(room, user, reason) and unban(room, user); a refusal does not stop the rest", async () => {
  const calls: unknown[][] = [];
  const client = {
    ban: async (...a: unknown[]) => { calls.push(["ban", ...a]); if (a[0] === "!a") throw Object.assign(new Error("x"), { errcode: "M_FORBIDDEN" }); },
    unban: async (...a: unknown[]) => { calls.push(["unban", ...a]); },
  };
  await runSiteBanPlan(client, [{ roomId: "!a", ban: ["@casey:site.test"], unban: [] }, { roomId: "!b", ban: ["@casey:site.test"], unban: ["@old:site.test"] }], async () => {});
  assert.deepEqual(calls, [
    ["ban", "!a", "@casey:site.test", SITE_BAN_REASON],
    ["ban", "!b", "@casey:site.test", SITE_BAN_REASON],
    ["unban", "!b", "@old:site.test"],
  ]);
});

test("a list that may be partial lifts NOTHING — bans still apply", () => {
  const rooms = [room("!a", {
    [MOD]: { pl: 50 },
    "@casey:site.test": { membership: "ban", reason: SITE_BAN_REASON },
    "@new:site.test": {},
  })];
  assert.deepEqual(siteBanPlan(rooms, ["@new:site.test"], MOD, false), [{ roomId: "!a", ban: ["@new:site.test"], unban: [] }],
    "a partial list let a still-banned account back in");
});

test("the list comes from the sync's own unlimited route; only an explicit complete:true counts as whole", async () => {
  const urls: string[] = [];
  const answer = (body: unknown, status = 200) => {
    globalThis.fetch = (async (u: RequestInfo | URL) => { urls.push(String(u)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  };
  answer({}, 403);
  assert.equal(await activeSiteBans(), null, "a refusal reconciles nothing (never 'nobody is banned')");
  answer({ matrixIds: ["@casey:site.test"], complete: true });
  assert.deepEqual(await activeSiteBans(), { ids: ["@casey:site.test"], complete: true });
  answer({ matrixIds: ["@casey:site.test"] });
  assert.deepEqual(await activeSiteBans(), { ids: ["@casey:site.test"], complete: false }, "no marker = partial");
  answer({ matrixIds: ["@casey:site.test", 7], complete: true });
  assert.equal((await activeSiteBans())?.complete, false, "a malformed entry makes the list partial");
  assert.ok(urls.every((u) => u === "/api/mod/bans/active"));
  const route = read("../api/mod/bans/active/route.ts");
  assert.match(route, /SELECT matrix_id FROM site\.bans WHERE expires_at IS NULL OR expires_at > NOW\(\) ORDER BY matrix_id`/);
  assert.doesNotMatch(route, /LIMIT/i, "the sync's list must not be capped");
  assert.match(route, /return Response\.json\(\{ matrixIds: rows\.map\(\(r\) => r\.matrix_id\), complete: true \}\);\s*\}\s*$/, "vacuity anchor");
});

test("a banned viewer cannot make a new DM room; an existing one still opens", async () => {
  const { openOrCreateDm } = await import("./matrixDm.ts");
  let created = 0;
  // An existing room the other person is still in (openOrCreateDm checks their membership).
  const people = [{ userId: "@me:site.test", membership: "join" }, { userId: "@sam:site.test", membership: "join" }];
  const dmRoom = {
    roomId: "!dm", getMyMembership: () => "join", isSpaceRoom: () => false, getDMInviter: () => undefined,
    getMembers: () => people, getLastActiveTimestamp: () => 0, getJoinedMemberCount: () => 2, getInvitedMemberCount: () => 0,
    getJoinRule: () => "invite", getHistoryVisibility: () => "shared", currentState: { getStateEvents: () => null },
    loadMembersIfNeeded: async () => true,
    getMember: (id: string) => {
      const m = people.find((p) => p.userId === id);
      return m ? { ...m, events: { member: { getContent: () => ({ membership: m.membership, is_direct: true }) } } } : null;
    },
  };
  const client = {
    getUserId: () => "@me:site.test",
    getAccountData: () => ({ getContent: () => ({ "@sam:site.test": ["!dm"] }) }),
    getRooms: () => [dmRoom],
    getRoom: (id: string) => (id === "!dm" ? dmRoom : null),
    createRoom: async () => { created++; return { room_id: "!new" }; },
  } as never;
  assert.equal(await openOrCreateDm(client, "@casey:site.test", async () => true), null);
  assert.equal(created, 0, "a room was made for a banned viewer");
  assert.equal((await openOrCreateDm(client, "@sam:site.test", async () => true))?.roomId, "!dm");
});


test("both DM routes refuse a banned caller before doing anything else", () => {
  for (const rel of ["../api/dm/resolve/route.ts", "../api/dm/ping/route.ts"]) {
    const src = read(rel);
    const handler = src.slice(src.lastIndexOf("export async function"));
    assert.match(handler, /if \(!me\) return Response\.json\(\{ error: "Sign in first\." \}, \{ status: 401 \}\);\s*const \{ rows: ban \} = await pool\.query\(ACTIVE_BAN_SQL, \[me\]\)[^\n]*\n\s*if \(ban\.length\) return Response\.json\(\{ error: DM_BANNED \}, \{ status: 403 \}\);/, rel);
  }
});

test("the community runs the sync for site mods only, and a ban from this tab reconciles at once", () => {
  const view = read("../features/community/MatrixView.tsx");
  assert.match(view, /useSiteBanSync\(isSiteMod \? client : null, syncRooms, myUserId\);/);
  // Both writers get the hub-only scope, never the open room (moderationSyncRooms.test.ts).
  assert.match(view, /useModPowerSync\([^;]*, syncRooms, myUserId\);/);
  assert.match(view, /moderationSyncRooms\(resolvedServer, rooms, myUserId, dmRoomIds\)/);
  const quick = read("./modQuickActions.ts");
  assert.match(quick, /trackPropagation\(what, d\);\s*siteBansChanged\(\);/);
  assert.match(quick, /export function siteBansChanged\(\): void \{/);
});

test("the DM room check is documented as a courtesy; the server routes are the control", () => {
  const dm = readFileSync(new URL("./matrixDm.ts", import.meta.url), "utf8");
  assert.match(dm, /The ban check below is a COURTESY, not a control/);
});

test("does nothing when the install has a reconciler", async () => {
  // The reconciler places and lifts the room bans then (spec 2026-10-23 §4.11): a mod's browser
  // makes none. Run for real in a React root; the same render with the reconciler off is the control.
  const { mountHook } = await import("./testDom.ts");
  const { useSiteBanSync } = await import("./siteBanSync.ts");
  const saved = process.env.INSTALL_VALUES;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: RequestInfo | URL) => {
    fetched.push(String(u));
    return new Response(JSON.stringify({ matrixIds: ["@casey:site.test"], complete: true }), { status: 200 });
  }) as typeof fetch;
  const writes: string[] = [];
  const client = {
    ban: async (r: string, u: string) => { writes.push(`ban ${r} ${u}`); },
    unban: async (r: string, u: string) => { writes.push(`unban ${r} ${u}`); },
  };
  const rooms = [room("!a", { [MOD]: { pl: 50 }, "@casey:site.test": {} })];
  const run = async (reconciler: string) => {
    process.env.INSTALL_VALUES = JSON.stringify({ "community.reconciler": reconciler });
    const h = await mountHook(() => useSiteBanSync(client, rooms, MOD));
    await h.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await h.unmount();
  };
  try {
    await run("true");
    assert.deepEqual(fetched, [], "with a reconciler: no ban list read");
    assert.deepEqual(writes, [], "with a reconciler: no room ban made");
    await run("false");
    assert.deepEqual(writes, ["ban !a @casey:site.test"], "control: without a reconciler the sync bans");
  } finally {
    if (saved === undefined) delete process.env.INSTALL_VALUES; else process.env.INSTALL_VALUES = saved;
  }
});
