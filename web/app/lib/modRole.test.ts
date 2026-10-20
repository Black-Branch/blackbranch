// The mod role: who passes the mod gate (a banned mod does not), the one write that grants or
// removes the role, and the routes that use them.
// Run: node --test app/lib/modRole.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { passesModGate, applyModRole, type RoleQuery } from "./modRole.ts";
import { stripComments } from "./testSource.ts";

test("a mod passes; a banned or timed-out mod does not — they could lift their own ban", () => {
  assert.equal(passesModGate({ is_mod: true, is_admin: false, banned: false }), true);
  assert.equal(passesModGate({ is_mod: true, is_admin: false, banned: true }), false);
});

test("an admin passes even while banned (the owner can always lift a ban on their own account)", () => {
  assert.equal(passesModGate({ is_mod: false, is_admin: true, banned: true }), true);
});

test("a viewer, and an account with no row, do not pass", () => {
  assert.equal(passesModGate({ is_mod: false, is_admin: false, banned: false }), false);
  assert.equal(passesModGate(undefined), false);
});

function fakeUsers(users: Record<string, boolean>): RoleQuery {
  return async (_sql, params) => {
    const [grant, id] = params as [boolean, string];
    if (!(id in users)) return { rows: [] };
    const was = users[id]!;
    users[id] = grant;
    return { rows: [{ was }] };
  };
}

test("applyModRole says whether the role moved, so only a real change is logged", async () => {
  const users = { "@rosalind:site.test": false };
  const q = fakeUsers(users);
  assert.equal(await applyModRole(q, "@rosalind:site.test", true), "changed");
  assert.equal(users["@rosalind:site.test"], true);
  assert.equal(await applyModRole(q, "@rosalind:site.test", true), "unchanged");
  assert.equal(await applyModRole(q, "@rosalind:site.test", false), "changed");
  assert.equal(await applyModRole(q, "@nobody:site.test", true), "not_found");
});

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));

test("requireMod and isModUser both read the gate row and decide with passesModGate", () => {
  const admin = read("./admin.ts");
  for (const fn of ["export async function isModUser", "export async function requireMod"]) {
    const body = admin.slice(admin.indexOf(fn));
    const end = body.indexOf("\n}");
    assert.ok(end > 0, `${fn} was read`);
    assert.match(body.slice(0, end), /\.query<ModGateRow>\(MOD_GATE_SQL, \[session\.user\.id\]\)/, `${fn} reads the gate row`);
    assert.match(body.slice(0, end), /passesModGate\(rows\[0\]\)/, `${fn} decides with passesModGate`);
  }
});

test("a PERMANENT ban of a mod removes the role and logs it; a timeout does not", () => {
  const ban = read("../api/mod/ban/route.ts");
  // One account's ban (round 5: a ban by canonical runs it for every linked account).
  const one = ban.slice(ban.indexOf("async function banAccount"), ban.indexOf("export async function POST"));
  const insert = one.indexOf("INSERT INTO site.bans");
  const revoke = one.indexOf("if (!a.durationMinutes && (await applyModRole(");
  assert.ok(insert > 0 && revoke > insert, "the role is removed after the ban is stored");
  assert.match(one.slice(revoke, revoke + 260), /targetId, false\)\) === "changed"\) \{\s*await appendModLog\(\{ action: "mod_revoked", target: targetId, by: a\.mod, reason: "banned" \}\);/);
  const post = ban.slice(ban.indexOf("export async function POST"), ban.indexOf("export async function DELETE"));
  assert.match(post, /for \(const t of targets\) results\.push\(await banAccount\(t, action\)\);/);
});

test("/mod and /unmod's route changes the role through applyModRole and logs only a change", () => {
  const route = read("../api/mod/setmod/route.ts");
  assert.match(route, /const admin = await requireAdmin\(\);\s*if \(!admin\) return new Response\("Forbidden — admin only", \{ status: 403 \}\);\s*const body/);
  assert.match(route, /if \(result === "changed"\) \{\s*await appendModLog\(\{ action: grant \? "mod_granted" : "mod_revoked", target: targetId, by: admin \}\);/);
  assert.match(route, /return Response\.json\(\{ ok: true, changed: result === "changed" \}\);\s*\}\s*$/, "vacuity anchor");
});

test("the owner's client gets the role's source of truth (site.users), never a list derived from the log", () => {
  const route = read("../api/community/mods/route.ts");
  assert.match(route, /SELECT matrix_id FROM site\.users WHERE \(is_mod OR is_admin\) AND deleted_at IS NULL/);
  assert.doesNotMatch(route, /mod_log/);
  assert.match(route, /return Response\.json\(\{ modIds: rows\.map\(\(r\) => r\.matrix_id\), keepIds: \[\.\.\.staffMatrixIds\(\)\] \}\);\s*\}\s*$/, "vacuity anchor");
});

test("account deletion records the end of a moderator's role before it clears is_mod", () => {
  const del = read("./accountDeletion.ts");
  const log = del.indexOf("INSERT INTO site.mod_log (action, target_id, performed_by, reason)");
  const erase = del.indexOf("counts = await eraseSiteData(client, matrixId, keep);");
  assert.ok(log > 0 && erase > log, "the mod_revoked row is written while is_mod still says who was a mod");
  assert.match(del.slice(log, log + 260), /SELECT 'mod_revoked', matrix_id, matrix_id, 'account deleted' FROM site\.users WHERE matrix_id = \$1 AND is_mod/);
});
