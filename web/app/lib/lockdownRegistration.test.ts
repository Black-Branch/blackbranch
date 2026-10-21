// The lockdown's "New signups" lever closes homeserver sign-up too, and puts it back when it lifts.
// Run: env -u DATABASE_URL node --test app/lib/lockdownRegistration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncLockdownRegistration, lockdownRegistrationState, lockdownDoctorFact } from "./lockdownRegistration.ts";

type Facts = {
  locked: boolean; registration: string | null; by: string | null; before: unknown;
  closedThisLockdown?: boolean; lastWrite?: string | null;
};

/** A fake install: the settings row, its history's last lockdown write, the lever, the host's render
 *  answers, a clock, and every call made. `renders` = whether each render request lands (default yes). */
function install(f: Facts, bundle = true, renders: boolean[] = []) {
  const calls: string[] = [];
  const clock = { t: Date.parse("2026-10-18T12:00:00Z") };
  let result: { ok: boolean; at: string } | null = null;
  const facts = { closedThisLockdown: false, lastWrite: null as string | null, ...f };
  const deps = {
    bundle: () => bundle,
    read: async () => ({ ...facts }),
    write: async (v: "open" | "closed") => {
      calls.push(`write ${v}`);
      facts.before = facts.registration === null ? null : JSON.parse(JSON.stringify(facts.registration));
      facts.registration = v; facts.by = "lockdown";
      if (v === "closed") facts.closedThisLockdown = true;
      facts.lastWrite = new Date(clock.t).toISOString();
      return true;
    },
    clear: async () => {
      calls.push("clear"); facts.registration = null; facts.by = null;
      facts.lastWrite = new Date(clock.t).toISOString();
      return true;
    },
    render: async () => {
      calls.push("render");
      const lands = renders.length ? renders.shift()! : true;
      result = { ok: lands, at: new Date(clock.t + 1000).toISOString() };
      return true;
    },
    renderResult: async () => result,
    now: () => clock.t,
    retry: { attempts: 0, nextAt: 0 },
  };
  return { f: facts, calls, deps, clock };
}

test("lever on with sign-up open: close it, as the lockdown, through a render", async () => {
  const i = install({ locked: true, registration: "open", by: "@admin:site.test", before: null });
  assert.equal(await syncLockdownRegistration(i.deps), "closed");
  assert.deepEqual(i.calls, ["write closed", "render"]);
  assert.deepEqual(await lockdownRegistrationState(i.deps), { managed: "bundle", registration: "closed", closedByLockdown: true, applied: true });
  // Run again (the minute timer): nothing more to do.
  assert.equal(await syncLockdownRegistration(i.deps), "none");
  assert.deepEqual(i.calls, ["write closed", "render"]);
});

test("the doctor's fact: the lockdown's last write and the host's last render, raw — the doctor judges them", async () => {
  const i = install({ locked: true, registration: "open", by: "@admin:site.test", before: null }, true, [false]);
  assert.deepEqual(await lockdownDoctorFact(i.deps), { managed: "bundle", registration: "open", closedByLockdown: false, lastWrite: null, render: null });
  await syncLockdownRegistration(i.deps); // closes; its render fails
  assert.deepEqual(await lockdownDoctorFact(i.deps), {
    managed: "bundle", registration: "closed", closedByLockdown: true, lastWrite: "2026-10-18T12:00:00.000Z", render: { ok: false, at: "2026-10-18T12:00:01.000Z" },
  });
  assert.deepEqual(await lockdownDoctorFact(install({ locked: false, registration: "open", by: null, before: null }, false).deps), { managed: "outside" });
});

test("lever off: the value from before the lockdown comes back, through a render", async () => {
  const i = install({ locked: true, registration: "open", by: "@admin:site.test", before: null });
  await syncLockdownRegistration(i.deps);
  i.f.locked = false; i.calls.length = 0;
  assert.equal(await syncLockdownRegistration(i.deps), "restored");
  assert.deepEqual(i.calls, ["write open", "render"]);
  assert.equal(i.f.registration, "open");
  assert.equal(await syncLockdownRegistration(i.deps), "none", "restored once, not again");
});

test("lever off after a lockdown that closed a sign-up with no saved value: the row is cleared back to unset", async () => {
  const i = install({ locked: false, registration: "closed", by: "lockdown", before: null });
  assert.equal(await syncLockdownRegistration(i.deps), "restored");
  assert.deepEqual(i.calls, ["clear", "render"]);
});

test("sign-up already closed: the lockdown changes nothing, and lifting it opens nothing", async () => {
  const i = install({ locked: true, registration: "closed", by: "@admin:site.test", before: null });
  assert.equal(await syncLockdownRegistration(i.deps), "none");
  i.f.locked = false;
  assert.equal(await syncLockdownRegistration(i.deps), "none");
  assert.deepEqual(i.calls, []);
  const unset = install({ locked: true, registration: null, by: null, before: null });
  assert.equal(await syncLockdownRegistration(unset.deps), "none", "unset = closed already");
});

test("an admin's change during the lockdown is theirs: lifting it never undoes it", async () => {
  const i = install({ locked: false, registration: "closed", by: "@admin:site.test", before: "open" });
  assert.equal(await syncLockdownRegistration(i.deps), "none");
  assert.deepEqual(i.calls, []);
});

test("not a bundle install: managed outside Black Branch — no request, nothing read", async () => {
  const i = install({ locked: true, registration: "open", by: null, before: null }, false);
  let read = false;
  const deps = { ...i.deps, read: async () => { read = true; return i.f; } };
  assert.equal(await syncLockdownRegistration(deps), "outside");
  assert.deepEqual(await lockdownRegistrationState(deps), { managed: "outside" });
  assert.deepEqual(i.calls, []);
  assert.equal(read, false);
});

test("a failed write is reported, never thrown, and retried by the next run", async () => {
  const i = install({ locked: true, registration: "open", by: null, before: null });
  const deps = { ...i.deps, write: async () => false };
  assert.equal(await syncLockdownRegistration(deps), "failed");
  assert.equal(await syncLockdownRegistration({ ...i.deps, read: async () => { throw new Error("db down"); } }), "failed");
  assert.equal(await syncLockdownRegistration(i.deps), "closed", "the next run closes it");
});

test("an admin who OPENS sign-up during the lockdown is kept: the minute check never re-closes it", async () => {
  const i = install({ locked: true, registration: "open", by: "@admin:site.test", before: null });
  assert.equal(await syncLockdownRegistration(i.deps), "closed");
  // The admin opens it again from the Admin Panel, while the lever stays on.
  i.f.registration = "open"; i.f.by = "@admin:site.test"; i.calls.length = 0;
  for (let m = 0; m < 5; m++) {
    i.clock.t += 60_000;
    assert.equal(await syncLockdownRegistration(i.deps), "none", "the lockdown re-closed an admin's change");
  }
  assert.deepEqual(i.calls, []);
  assert.deepEqual(await lockdownRegistrationState(i.deps), { managed: "bundle", registration: "open", closedByLockdown: false, applied: true });
});

test("a NEW lockdown closes sign-up an admin opened before it began (the earlier lockdown's close does not count)", async () => {
  const i = install({ locked: true, registration: "open", by: "@admin:site.test", before: "closed", closedThisLockdown: false,
    lastWrite: "2026-09-01T00:00:00.000Z" });
  assert.equal(await syncLockdownRegistration(i.deps), "closed");
  assert.deepEqual(i.calls, ["write closed", "render"]);
});

test("a render that does not land is shown as not applied and asked for again, with backoff, until one does", async () => {
  const i = install({ locked: true, registration: "open", by: null, before: null }, true, [false, false, false, true]);
  assert.equal(await syncLockdownRegistration(i.deps), "closed");
  const state = await lockdownRegistrationState(i.deps);
  assert.equal(state.managed === "bundle" && state.applied, false, "a failed render reads as applied");
  i.calls.length = 0;
  const at: number[] = [];
  for (let m = 1; m <= 40; m++) {
    i.clock.t += 60_000;
    if ((await syncLockdownRegistration(i.deps)) === "retried") at.push(m);
  }
  assert.deepEqual(at, [2, 4, 8], "retries at 2, then 4 more, then … minutes — and none once a render landed");
  assert.deepEqual(i.calls, ["render", "render", "render"]);
  const after = await lockdownRegistrationState(i.deps);
  assert.equal(after.managed === "bundle" && after.applied, true);
});

test("a render request that could not even be dropped counts as not landed", async () => {
  const i = install({ locked: true, registration: "open", by: null, before: null });
  const deps = { ...i.deps, render: async () => { i.calls.push("render"); return false; } };
  assert.equal(await syncLockdownRegistration(deps), "closed");
  const s = await lockdownRegistrationState(deps);
  assert.equal(s.managed === "bundle" && s.applied, false);
  i.clock.t += 2 * 60_000;
  assert.equal(await syncLockdownRegistration(deps), "retried");
});

// The read, against a real Postgres, with the route's OWN lever write: "this lockdown closed it" is
// a lockdown close at or after site.lockdown.signups_disabled_at — the lever's own column (v157),
// never the mod log.
test("the facts read on a real Postgres", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url || url === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(url)) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL unset or unsafe");
    return;
  }
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Client } = await import("pg");
  const { READ_SQL } = await import("./lockdownRegistration.ts");
  const route = readFileSync(join(process.cwd(), "app/api/mod/lockdown/route.ts"), "utf8");
  const at = route.indexOf("`UPDATE site.lockdown l SET");
  const LEVER_SQL = route.slice(at + 1, route.indexOf("`", at + 1));
  assert.match(LEVER_SQL, /signups_disabled_at\s+= CASE/, "the route's lever write was not found");
  const lever = (on: boolean | null) => [on, null, null, null, null, false, null, false, null, "@m:site.test", false, null];
  const W = "lockdown";
  const db = new Client({ connectionString: url });
  await db.connect();
  // Inside one transaction that is rolled back: the shared singleton and setting are never left
  // changed. now() is fixed in a transaction, so "time passes" is a backdate of the stored values.
  await db.query("BEGIN");
  try {
    await db.query(`DELETE FROM site.instance_history WHERE key = 'matrix.registration'`);
    await db.query(`DELETE FROM site.mod_log WHERE action = 'signups_disabled'`);
    await db.query(`INSERT INTO site.lockdown (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await db.query(`UPDATE site.lockdown SET signups_disabled = false, signups_disabled_at = NULL, expires_at = NULL, until_stream = NULL WHERE id = 1`);
    const read = async () => (await db.query(READ_SQL, [W])).rows[0];
    const close = (ago: string) => db.query(`INSERT INTO site.instance_history (key, tier, action, old_value, new_value, updated_by, updated_at)
      VALUES ('matrix.registration', 'instance', 'set', '"open"', '"closed"', $1, now() - $2::interval)`, [W, ago]);

    // An EARLIER lockdown closed it two days ago. The lever goes on now — with no mod log row.
    await close("2 days");
    await db.query(LEVER_SQL, lever(true));
    let r = await read();
    assert.equal(r.locked, true);
    assert.equal(r.closed_this_lockdown, false, "an earlier lockdown's close counted: an admin's open would stay open");
    assert.equal((await db.query(`SELECT 1 FROM site.mod_log WHERE action = 'signups_disabled'`)).rowCount, 0);

    // This lockdown closes it; an hour passes; a mod saves "on" again — not a new lockdown.
    await close("0 seconds");
    await db.query(`UPDATE site.lockdown SET signups_disabled_at = signups_disabled_at - interval '1 hour' WHERE id = 1`);
    await db.query(`UPDATE site.instance_history SET updated_at = updated_at - interval '1 hour' WHERE key = 'matrix.registration' AND updated_at > now() - interval '1 minute'`);
    assert.equal((await read()).closed_this_lockdown, true);
    await db.query(LEVER_SQL, lever(true));
    assert.equal((await read()).closed_this_lockdown, true, "a repeated 'on' moved the boundary: an admin's deliberate open would be re-closed");
    await db.query(LEVER_SQL, lever(null));
    assert.equal((await read()).closed_this_lockdown, true, "another lever's change moved the boundary");

    // Off, then on again: a new lockdown, which closes it again.
    await db.query(LEVER_SQL, lever(false));
    assert.equal((await db.query(`SELECT signups_disabled_at FROM site.lockdown WHERE id = 1`)).rows[0].signups_disabled_at, null);
    await db.query(LEVER_SQL, lever(true));
    r = await read();
    assert.equal(r.closed_this_lockdown, false);
    assert.equal(r.before, "open");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
