// Admin Panel › Moderators › Staff: the routes that give and take the site's Staff role
// (site.users.is_staff, Staff on the community ladder), then ask the host for a reconciler run.
// Mocked query + spies; the real-Postgres half is staffRole.db.test.ts.
// Run: env -u DATABASE_URL node --test app/lib/community/staffRole.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../sourceText.mjs";
import { setStaffResponse, staffListResponse, type StaffDeps } from "./staffRole.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = "@owner:example.test";
const SAM = "@sam:example.test";

type Call = { sql: string; params: unknown[] };

/** A database where `was` is the account's is_staff before the write (undefined: no such account). */
function harness(was: Record<string, boolean>, opts: { asked?: boolean; failWrite?: boolean } = {}) {
  const calls: Call[] = [];
  const logged: [string, string, string][] = [];
  const order: string[] = [];
  let asks = 0;
  const deps: StaffDeps = {
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/UPDATE site\.users/.test(sql)) {
        order.push("write");
        if (opts.failWrite) throw new Error("connection refused");
        const target = params[1] as string;
        if (!(target in was)) return { rows: [] };
        const before = was[target]!;
        was[target] = params[0] as boolean;
        return { rows: [{ was: before }] };
      }
      return { rows: [] };
    },
    log: async (action, target, by) => { order.push("log"); logged.push([action, target, by]); },
    reconcile: async () => { order.push("ask"); asks++; return opts.asked ?? true; },
  };
  return { deps, calls, logged, order, asks: () => asks, was };
}

const post = (body: unknown) => new Request("http://x/api/admin/staff", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

test("staff add/remove requests community-reconcile", async () => {
  const h = harness({ [SAM]: false });
  const add = await read(await setStaffResponse(post({ targetId: SAM, grant: true }), ADMIN, h.deps));
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual(add.body, { ok: true, changed: true, requested: true });
  assert.equal(h.was[SAM], true, "site.users.is_staff is set");
  const remove = await read(await setStaffResponse(post({ targetId: SAM, grant: false }), ADMIN, h.deps));
  assert.deepEqual(remove.body, { ok: true, changed: true, requested: true });
  assert.equal(h.was[SAM], false, "site.users.is_staff is cleared");
  assert.deepEqual(h.order, ["write", "log", "ask", "write", "log", "ask"], "the database first, then the log, then the host");
  assert.deepEqual(h.logged, [["staff_granted", SAM, ADMIN], ["staff_revoked", SAM, ADMIN]]);
  const write = h.calls.find((c) => /UPDATE site\.users/.test(c.sql))!;
  assert.match(write.sql, /SET is_staff = \$1/, "the Staff flag, not the mod flag");
  assert.doesNotMatch(write.sql, /is_mod\s*=/, "a mod who becomes Staff stays a mod");
  assert.match(write.sql, /deleted_at IS NULL/, "a deleted account is never made Staff");
});

test("staff add: the host's answer is passed on; an install without the reconciler is still saved", async () => {
  const h = harness({ [SAM]: false }, { asked: false });
  const r = await read(await setStaffResponse(post({ targetId: SAM, grant: true }), ADMIN, h.deps));
  assert.deepEqual(r.body, { ok: true, changed: true, requested: false });
  assert.equal(h.was[SAM], true);
});

test("staff retry: the same add again changes nothing, logs nothing, and asks the host again", async () => {
  const h = harness({ [SAM]: false });
  await setStaffResponse(post({ targetId: SAM, grant: true }), ADMIN, h.deps);
  const again = await read(await setStaffResponse(post({ targetId: SAM, grant: true }), ADMIN, h.deps));
  assert.deepEqual(again.body, { ok: true, changed: false, requested: true });
  assert.equal(h.logged.length, 1, "one log line for one change");
  assert.equal(h.asks(), 2, "a press after a host that did not answer is how the change is sent again");
});

test("staff: no such account is 404 and asks nobody; a bad body is 400 and touches nothing", async () => {
  const h = harness({});
  const r = await read(await setStaffResponse(post({ targetId: "@nobody:example.test", grant: true }), ADMIN, h.deps));
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "No account by that name.");
  for (const bad of [null, {}, { targetId: SAM }, { targetId: "", grant: true }, { targetId: SAM, grant: "yes" }, [SAM]]) {
    const b = await read(await setStaffResponse(post(bad), ADMIN, h.deps));
    assert.equal(b.status, 400, JSON.stringify(bad));
  }
  assert.equal(h.calls.filter((c) => /UPDATE/.test(c.sql)).length, 1, "only the 404 reached the database");
  assert.equal(h.asks(), 0);
  assert.equal(h.logged.length, 0);
});

test("staff: a database that does not answer is 503, and the host is not asked", async () => {
  const h = harness({ [SAM]: false }, { failWrite: true });
  const r = await read(await setStaffResponse(post({ targetId: SAM, grant: true }), ADMIN, h.deps));
  assert.equal(r.status, 503);
  assert.equal(h.asks(), 0);
  assert.equal(h.logged.length, 0);
});

test("the Staff list reads site.users.is_staff, live accounts only, with when each was given it", async () => {
  const calls: Call[] = [];
  const res = await staffListResponse(async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return { rows: [{ matrix_id: SAM, display_name: "Sam", since: new Date("2026-10-20T10:00:00Z") }, { matrix_id: "@ann:example.test", display_name: null, since: null }] };
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { staff: [
    { matrixId: SAM, displayName: "Sam", since: "2026-10-20T10:00:00.000Z" },
    { matrixId: "@ann:example.test", displayName: null, since: null },
  ] });
  assert.match(calls[0]!.sql, /WHERE u\.is_staff AND u\.deleted_at IS NULL/);
  assert.match(calls[0]!.sql, /l\.action = 'staff_granted'/);
});

test("the staff route: admin only and same-origin on the write, and it asks through the one reconcile helper", () => {
  const src = stripComments(readFileSync(join(here, "../../api/admin/staff/route.ts"), "utf8"));
  assert.match(src, /export async function GET\(\) \{\s*const admin = await requireAdminResponse\(\);\s*if \(admin instanceof Response\) return admin;/);
  assert.match(src, /export async function POST\(req: Request\) \{\s*const admin = await requireAdminMutation\(req\);\s*if \(admin instanceof Response\) return admin;/);
  assert.match(src, /reconcile: \(\) => requestReconcile\(\)/, "gated on community.reconciler by requestReconcile");
  assert.match(src, /log: \(action, target, by\) => appendModLog\(\{ action, target, by \}\)/);
});
