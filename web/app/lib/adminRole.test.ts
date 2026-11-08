// A2-07 (KG-12, Q2): a second admin. Any admin makes or removes an admin, never the last one, and
// every change is a mod-log row. The handlers run here over an injected query; the SQL runs on the
// real schema below (SQL_PARSE_DATABASE_URL — a replayed throwaway database; CI sets it; never prod),
// including two admins removing each other at the same moment.
// Run: node --test app/lib/adminRole.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { setAdminResponse, adminListResponse, isLastAdmin, releaseAdminInTx, type AdminDeps } from "./adminRole.ts";

const post = (body: unknown) => new Request("https://site.test/api/admin/admins", { method: "POST", body: JSON.stringify(body) });

/** site.users in memory: is_admin per live account. Answers the module's statements by shape. */
function users(init: Record<string, boolean>) {
  const t = new Map(Object.entries(init));
  const query: AdminDeps["query"] = async (sql, params) => {
    if (/UPDATE site\.users u SET is_admin = \$1/.test(sql)) {
      const [grant, id] = params as [boolean, string];
      if (!t.has(id)) return { rows: [] };
      const was = t.get(id)!;
      const others = [...t].filter(([k, v]) => v && k !== id).length;
      if (!grant && was && others === 0) return { rows: [] };
      t.set(id, grant);
      return { rows: [{ was }] };
    }
    if (/SELECT is_admin FROM site\.users WHERE matrix_id = \$1 AND deleted_at IS NULL/.test(sql)) {
      const id = params[0] as string;
      return { rows: t.has(id) ? [{ is_admin: t.get(id) }] : [] };
    }
    if (/FROM site\.users u\s+WHERE u\.is_admin AND u\.deleted_at IS NULL/.test(sql)) {
      return { rows: [...t].filter(([, v]) => v).map(([k]) => ({ matrix_id: k, display_name: null, since: null })) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { t, query };
}

function deps(q: AdminDeps["query"]) {
  const logged: [string, string, string][] = [];
  const asked = { n: 0 };
  const d: AdminDeps = { query: q, log: async (a, target, by) => { logged.push([a, target, by]); }, reconcile: async () => { asked.n++; return true; } };
  return { d, logged, asked };
}

test("a change asks the community reconciler for a run at once (room power follows the role), like Staff", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": false });
  const { d, asked } = deps(db.query);
  const res = await setAdminResponse(post({ targetId: "@robin:site.test", grant: true }), "@owner:site.test", d);
  assert.deepEqual(await res.json(), { ok: true, changed: true, requested: true });
  assert.equal(asked.n, 1);
  // A refusal asks nothing; the database down asks nothing.
  await setAdminResponse(post({ targetId: "@nobody:site.test", grant: true }), "@owner:site.test", d);
  assert.equal(asked.n, 1);
  // A reconcile that throws never turns a saved change into an error.
  const shaky = await setAdminResponse(post({ targetId: "@robin:site.test", grant: false }), "@owner:site.test", { ...d, reconcile: async () => { throw new Error("no host"); } });
  assert.deepEqual(await shaky.json(), { ok: true, changed: true, requested: false });
});

test("an admin makes another account an admin; the change is a mod-log row", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": false });
  const { d, logged } = deps(db.query);
  const res = await setAdminResponse(post({ targetId: "@robin:site.test", grant: true }), "@owner:site.test", d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, changed: true, requested: true });
  assert.equal(db.t.get("@robin:site.test"), true);
  assert.deepEqual(logged, [["admin_granted", "@robin:site.test", "@owner:site.test"]]);
});

test("any admin removes an admin, themselves included, while another admin is left", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": true });
  const { d, logged } = deps(db.query);
  const res = await setAdminResponse(post({ targetId: "@owner:site.test", grant: false }), "@robin:site.test", d);
  assert.equal(res.status, 200);
  assert.equal(db.t.get("@owner:site.test"), false);
  assert.deepEqual(logged, [["admin_revoked", "@owner:site.test", "@robin:site.test"]]);
});

test("the last admin is never removed: 409 with the reason, nothing changed, nothing logged", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": false });
  const { d, logged } = deps(db.query);
  const res = await setAdminResponse(post({ targetId: "@owner:site.test", grant: false }), "@owner:site.test", d);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /only admin/);
  assert.equal(db.t.get("@owner:site.test"), true);
  assert.deepEqual(logged, []);
});

test("no such account is a 404; a bad body a 400; the database down a 503; a no-op is not logged", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": true });
  const { d, logged } = deps(db.query);
  assert.equal((await setAdminResponse(post({ targetId: "@nobody:site.test", grant: true }), "@owner:site.test", d)).status, 404);
  for (const b of [null, [], { targetId: "", grant: true }, { targetId: "@x:site.test", grant: "yes" }]) {
    assert.equal((await setAdminResponse(post(b), "@owner:site.test", d)).status, 400, JSON.stringify(b));
  }
  const again = await setAdminResponse(post({ targetId: "@robin:site.test", grant: true }), "@owner:site.test", d);
  assert.deepEqual(await again.json(), { ok: true, changed: false, requested: true });
  assert.deepEqual(logged, []);
  const down = await setAdminResponse(post({ targetId: "@robin:site.test", grant: true }), "@owner:site.test", { ...d, query: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.status, 503);
});

test("the list: every live admin", async () => {
  const db = users({ "@owner:site.test": true, "@robin:site.test": true, "@casey:site.test": false });
  const res = await adminListResponse(db.query);
  assert.deepEqual(((await res.json()) as { admins: { matrixId: string }[] }).admins.map((a) => a.matrixId).sort(), ["@owner:site.test", "@robin:site.test"]);
});

test("the real schema: grant, refuse the last, and two admins removing each other at once leave one", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect(); await b.connect();
  const ids = ["@a207test-one:site.test", "@a207test-two:site.test"];
  // Other admins on the throwaway database would make "the last admin" untestable: set them aside
  // for the test and put them back after.
  const others = (await a.query<{ matrix_id: string }>(`SELECT matrix_id FROM site.users WHERE is_admin AND deleted_at IS NULL AND matrix_id <> ALL($1)`, [ids])).rows.map((r) => r.matrix_id);
  try {
    await a.query(`UPDATE site.users SET is_admin = FALSE WHERE matrix_id = ANY($1)`, [others]);
    await a.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [ids]);
    await a.query(`INSERT INTO site.users (matrix_id, display_name, is_admin) VALUES ($1, 'one', TRUE), ($2, 'two', FALSE)`, ids);
    const qa: AdminDeps["query"] = (sql, p) => a.query(sql, p);
    const qb: AdminDeps["query"] = (sql, p) => b.query(sql, p);
    const nolog = { log: async () => {}, reconcile: async () => false };

    assert.equal(await isLastAdmin(qa, ids[0]!), true);
    assert.equal((await setAdminResponse(post({ targetId: ids[0], grant: false }), ids[0]!, { query: qa, ...nolog })).status, 409);
    assert.equal((await setAdminResponse(post({ targetId: ids[1], grant: true }), ids[0]!, { query: qa, ...nolog })).status, 200);
    assert.equal(await isLastAdmin(qa, ids[0]!), false);

    // Both remove the OTHER at the same moment, each in its own connection: exactly one wins.
    const [r1, r2] = await Promise.all([
      setAdminResponse(post({ targetId: ids[1], grant: false }), ids[0]!, { query: qa, ...nolog }),
      setAdminResponse(post({ targetId: ids[0], grant: false }), ids[1]!, { query: qb, ...nolog }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const left = (await a.query(`SELECT count(*)::int AS n FROM site.users WHERE matrix_id = ANY($1) AND is_admin`, [ids])).rows[0].n;
    assert.equal(left, 1, "never zero admins");
  } finally {
    await a.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [ids]);
    await a.query(`UPDATE site.users SET is_admin = TRUE WHERE matrix_id = ANY($1)`, [others]);
    await a.end(); await b.end();
  }
});

test("the real schema: two admins deleting themselves at once — each in its own transaction — leave one admin", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const a = new Client({ connectionString: url });
  const b = new Client({ connectionString: url });
  await a.connect(); await b.connect();
  const ids = ["@a207del-one:site.test", "@a207del-two:site.test"];
  const others = (await a.query<{ matrix_id: string }>(`SELECT matrix_id FROM site.users WHERE is_admin AND deleted_at IS NULL AND matrix_id <> ALL($1)`, [ids])).rows.map((r) => r.matrix_id);
  try {
    await a.query(`UPDATE site.users SET is_admin = FALSE WHERE matrix_id = ANY($1)`, [others]);
    await a.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [ids]);
    await a.query(`INSERT INTO site.users (matrix_id, display_name, is_admin) VALUES ($1, 'one', TRUE), ($2, 'two', TRUE)`, ids);
    // The deletion's transaction, as deleteAccount runs it: BEGIN, the guard, the erase, COMMIT.
    const deletion = async (c: Client, who: string): Promise<"deleted" | "refused"> => {
      await c.query("BEGIN");
      if (await releaseAdminInTx((sql, p) => c.query(sql, p), who) === "last") { await c.query("ROLLBACK"); return "refused"; }
      await c.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [who]);
      await new Promise((r) => setTimeout(r, 50)); // the erase takes a moment; the other deletion waits on the lock
      await c.query("COMMIT");
      return "deleted";
    };
    const outcomes = await Promise.all([deletion(a, ids[0]!), deletion(b, ids[1]!)]);
    assert.deepEqual([...outcomes].sort(), ["deleted", "refused"]);
    const left = (await a.query(`SELECT count(*)::int AS n FROM site.users WHERE matrix_id = ANY($1) AND is_admin AND deleted_at IS NULL`, [ids])).rows[0].n;
    assert.equal(left, 1, "never zero admins");
  } finally {
    await a.query("ROLLBACK").catch(() => {}); await b.query("ROLLBACK").catch(() => {});
    await a.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [ids]);
    await a.query(`UPDATE site.users SET is_admin = TRUE WHERE matrix_id = ANY($1)`, [others]);
    await a.end(); await b.end();
  }
});
