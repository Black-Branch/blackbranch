// `blackbranch user admin <name> on|off` (A2-07, KG-12): the host's way to make or remove an admin —
// above all when nobody can sign in as one. Any admin may be made; the last one is never removed; the
// change is a mod-log row. The host command runs for real on a scratch install home with stand-ins
// for docker and systemctl (scratch-home.mjs fakeHome): nothing real is ever called.
// Its SQL also runs through real psql on a throwaway database when SQL_PARSE_DATABASE_URL names one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fakeHome } from "./scratch-home.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function box(answer) {
  const h = fakeHome();
  if (answer) writeFileSync(path.join(h.fake, "user-admin-out"), `${answer}\n`);
  return h;
}

test("user admin <name> on: the account on this server, the values as psql variables, never in the SQL text", () => {
  const h = box("changed");
  try {
    const r = h.run("user", "admin", "robin", "on");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /@robin:example\.test is now an admin/);
    const call = h.calls().split("\n").find((l) => l.includes("psql") && l.includes("m=")) ?? "";
    assert.match(call, /-v m=@robin:example\.test -v g=true/);
    const sql = readFileSync(path.join(h.fake, "user-admin-sql"), "utf8");
    assert.doesNotMatch(sql, /robin/, "the name never reaches the SQL text");
    assert.match(sql, /FOR UPDATE/, "the admin rows are locked: never the last one, even against a removal in the panel");
    assert.match(sql, /INSERT INTO site\.mod_log \(action, target_id, performed_by, reason\)/);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("user admin <name> off: the answers — removed, already not one, no such account, the last admin", () => {
  for (const [answer, status, says] of [
    ["changed", 0, /@robin:example\.test is no longer an admin/],
    ["same", 0, /already/],
    ["missing", 1, /no account @robin:example\.test on this site/],
    ["last", 1, /only admin: make someone else an admin first/],
  ]) {
    const h = box(answer);
    try {
      const r = h.run("user", "admin", "@robin:example.test", "off");
      assert.equal(r.status, status, `${answer}: ${r.stderr}`);
      assert.match(r.stdout + r.stderr, says, answer);
      assert.match(h.calls(), /-v g=false/);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test("a change asks the community reconciler for a run (room power follows the role); a no-op, a refusal or the switch off asks nothing", () => {
  const started = (h) => h.calls().split("\n").filter((l) => l === "systemctl start --no-block blackbranch-community@apply.service").length;
  for (const [answer, extra, want] of [["changed", "", 1], ["same", "", 0], ["last", "", 0], ["missing", "", 0], ["changed", "COMMUNITY_RECONCILER=false", 0]]) {
    const h = fakeHome(extra);
    try {
      writeFileSync(path.join(h.fake, "user-admin-out"), `${answer}\n`);
      h.run("user", "admin", "robin", answer === "last" ? "off" : "on");
      assert.equal(started(h), want, `${answer} ${extra}`);
    } finally { rmSync(h.home, { recursive: true, force: true }); }
  }
});

test("user: a wrong use is refused before the database is asked", () => {
  const h = box("changed");
  try {
    for (const args of [[], ["admin"], ["admin", "robin"], ["admin", "robin", "maybe"], ["promote", "robin", "on"], ["admin", "Robin Smith", "on"], ["admin", "x'; DROP TABLE site.users; --", "on"]]) {
      const r = h.run("user", ...args);
      assert.notEqual(r.status, 0, args.join(" "));
      assert.match(r.stderr, /usage: blackbranch user admin <name> on\|off|not an account name/, args.join(" "));
    }
    assert.doesNotMatch(h.calls(), /psql/, "nothing reached the database");
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test("help lists the verb; it is no longer 'not in this release'", () => {
  const src = readFileSync(path.join(here, "blackbranch"), "utf8");
  assert.match(src, /^#   blackbranch user admin <name> on\|off /m);
  assert.doesNotMatch(src, /user\)\s+not_yet/);
  assert.match(src, /^ {2}user\)\s+cmd_user "\$@" ;;$/m);
});

test("the verb's SQL on Postgres: grant, refuse the last, log the change", (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  const psql = spawnSync("psql", ["--version"], { encoding: "utf8" });
  if (!url || psql.status !== 0) { t.skip("SQL_PARSE_DATABASE_URL or psql missing"); return; }
  const src = readFileSync(path.join(here, "blackbranch"), "utf8");
  const sql = /USER_ADMIN_SQL=\$\(cat <<'SQL'\n([\s\S]*?)\nSQL\n\)/.exec(src)?.[1];
  assert.ok(sql, "the verb's SQL was not found");
  const q = (s, vars = {}) => {
    const r = spawnSync("psql", [url, "-qAt", "-v", "ON_ERROR_STOP=1", ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])],
      { input: s, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const one = "@a207host-one:site.test", two = "@a207host-two:site.test";
  const others = q(`SELECT string_agg(matrix_id, ' ') FROM site.users WHERE is_admin AND deleted_at IS NULL AND matrix_id NOT IN ('${one}', '${two}')`).split(" ").filter(Boolean);
  const restore = others.map((m) => m.replace(/'/g, "''"));
  try {
    if (restore.length) q(`UPDATE site.users SET is_admin = FALSE WHERE matrix_id IN (${restore.map((m) => `'${m}'`).join(",")})`);
    q(`DELETE FROM site.mod_log WHERE target_id IN ('${one}', '${two}'); DELETE FROM site.users WHERE matrix_id IN ('${one}', '${two}');
       INSERT INTO site.users (matrix_id, display_name, is_admin) VALUES ('${one}', 'one', TRUE), ('${two}', 'two', FALSE);`);
    assert.equal(q(sql, { m: one, g: "false" }), "last");
    assert.equal(q(sql, { m: "@a207host-nobody:site.test", g: "true" }), "missing");
    assert.equal(q(sql, { m: two, g: "true" }), "changed");
    assert.equal(q(sql, { m: two, g: "true" }), "same");
    assert.equal(q(sql, { m: one, g: "false" }), "changed");
    assert.equal(q(`SELECT string_agg(action || ' ' || target_id || ' ' || performed_by, ',' ORDER BY id) FROM site.mod_log WHERE target_id IN ('${one}', '${two}')`),
      `admin_granted ${two} blackbranch,admin_revoked ${one} blackbranch`);
  } finally {
    q(`DELETE FROM site.mod_log WHERE target_id IN ('${one}', '${two}'); DELETE FROM site.users WHERE matrix_id IN ('${one}', '${two}');`);
    if (restore.length) q(`UPDATE site.users SET is_admin = TRUE WHERE matrix_id IN (${restore.map((m) => `'${m}'`).join(",")})`);
  }
});
