// GET /api/community/mods: the admin's mod list (unchanged) and, for every signed-in member, the
// ladder the community client draws with (hub, hidden accounts, roles, Staff and Bot rungs).
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/community/modsAnswer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { communityModsResponse } from "./modsAnswer.ts";
import type { FeedEnv } from "./desiredServer.ts";

const ENV: FeedEnv = {
  serverName: "example.test",
  serviceUserId: "@blackbranch:example.test",
  readerUserId: "@reader:example.test",
  hubRoomId: "!configured-hub:example.test",
  streamerId: "@streamer:example.test",
  botIds: ["@bot:example.test"],
  sources: ["stripe"],
  putBack: true,
  retentionCapDays: 365,
  bridgeAccounts: [],
};

const ROLE = { key: "admin", label: "Admin", level: 100, colour: null, hoist: true, orderKey: "a0", builtin: true };
type Row = Record<string, unknown>;
const user = (matrix_id: string, flags: Partial<Record<"is_admin" | "is_staff" | "is_mod" | "is_bot", boolean>>): Row =>
  ({ matrix_id, is_admin: false, is_staff: false, is_mod: false, is_bot: false, ...flags });

function fakeDb(opts: { users?: Row[]; failLadder?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    query: async <R extends object>(sql: string): Promise<{ rows: R[] }> => {
      calls.push(sql);
      const rows = (r: Row[]) => ({ rows: r as R[] });
      if (/FROM site\.community_roles/.test(sql)) {
        if (opts.failLadder) throw new Error("db down");
        return rows([ROLE]);
      }
      if (/FROM site\.community_spaces/.test(sql)) return rows([]);
      if (/FROM site\.community_rooms/.test(sql)) return rows([]);
      if (/WHERE \(is_mod OR is_admin\)/.test(sql)) return rows([{ matrix_id: "@ada:example.test" }, { matrix_id: "@mo:example.test" }]);
      if (/FROM site\.users/.test(sql)) return rows(opts.users ?? []);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const USERS = [
  user("@ada:example.test", { is_admin: true }),
  user("@sam:example.test", { is_staff: true }),
  user("@mo:example.test", { is_mod: true }),
  user("@flagged:example.test", { is_bot: true, is_mod: true }),
  user("@blackbranch:example.test", { is_staff: true, is_bot: true }),
];

const deps = (viewer: { id: string; admin: boolean } | null, db = fakeDb({ users: USERS })) => ({
  viewer: async () => viewer,
  db,
  env: () => ENV,
  keepIds: () => ["@streamer:example.test", "@bot:example.test"],
  log: { error: () => {} },
});

test("the mods answer: an admin gets modIds and keepIds as before, plus hiddenIds, roles, staffIds, botIds and the hub", async () => {
  const res = await communityModsResponse(deps({ id: "@ada:example.test", admin: true }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["botIds", "hiddenIds", "hubRoomId", "keepIds", "modIds", "roles", "staffIds"]);
  assert.deepEqual(body.modIds, ["@ada:example.test", "@mo:example.test"], "site.users is the mod list's source, as before");
  assert.deepEqual(body.keepIds, ["@streamer:example.test", "@bot:example.test"]);
  assert.deepEqual(body.hiddenIds, ["@blackbranch:example.test", "@reader:example.test"], "the same hidden rule as the reconciler's feed");
  assert.deepEqual(body.roles, [ROLE]);
  assert.deepEqual(body.staffIds, ["@sam:example.test"], "site.users.is_staff; a hidden account is never listed on a rung");
  assert.deepEqual(body.botIds, ["@bot:example.test", "@flagged:example.test"], "is_bot plus the settings' bot accounts, as the feed levels them");
  assert.equal(body.hubRoomId, "!configured-hub:example.test");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a signed-in member who is not an admin gets the ladder only — never the mod list or keepIds", async () => {
  const res = await communityModsResponse(deps({ id: "@viewer:example.test", admin: false }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["botIds", "hiddenIds", "hubRoomId", "roles", "staffIds"]);
});

test("signed out: refused, and nothing is read", async () => {
  const db = fakeDb({ users: USERS });
  const res = await communityModsResponse(deps(null, db));
  assert.equal(res.status, 401);
  assert.deepEqual(db.calls, []);
});

test("retry: a ladder that cannot be read leaves the admin's mod list working; the next request reads it again", async () => {
  const down = fakeDb({ users: USERS, failLadder: true });
  const first = await communityModsResponse(deps({ id: "@ada:example.test", admin: true }, down));
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(await first.json()).sort(), ["keepIds", "modIds"], "the old answer, whole");
  const member = await communityModsResponse(deps({ id: "@viewer:example.test", admin: false }, down));
  assert.equal(member.status, 503, "a member with no ladder is told so, not handed an empty one");
  const again = await communityModsResponse(deps({ id: "@ada:example.test", admin: true }));
  assert.ok("roles" in (await again.json()), "no failure is remembered between requests");
});

test("restart: the answer holds no process state — two reads of the same rows give the same body", async () => {
  const a = await (await communityModsResponse(deps({ id: "@ada:example.test", admin: true }))).json();
  const b = await (await communityModsResponse(deps({ id: "@ada:example.test", admin: true }))).json();
  assert.deepEqual(a, b);
});

test("the route is one call into communityModsResponse with the session, the pool and the settings", () => {
  const route = readFileSync(join(import.meta.dirname, "..", "..", "api", "community", "mods", "route.ts"), "utf8");
  assert.match(route, /return communityModsResponse\(\{[\s\S]*db: pool,[\s\S]*env: feedEnv,[\s\S]*keepIds: staffMatrixIds,[\s\S]*\}\);\s*\}\s*$/, "vacuity anchor: the route's last statement");
  assert.match(route, /admin: \(await requireAdmin\(\)\) === id/, "admin is the same gate as before (requireAdmin)");
});
