// Ticket #193 against a real Postgres (a mock accepts any SQL): `/dm` finds EVERY site account by
// username or display name, the typed text anywhere in either (two characters or more), ranked
// exact → starts with → holds it, ties by Matrix id; at most 8; never yourself, a bot, a deleted or
// an install account. `exact` (open without asking) only for ONE account named outright.
//
// The database is SHARED with the other suites: everything here is one transaction, rolled back.
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/scratch node --test app/lib/dm/resolvePeople.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { resolvePeople, type PeopleQuery } from "./resolvePeople.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const id = (name: string, server = "dmfind.test") => `@${name}:${server}`;
const ME = id("asker");
const SERVICE = id("community");
const OWN = "dmfind.test";

async function withDb(t: { skip: (m: string) => void }, fn: (q: PeopleQuery, db: Client) => Promise<void>) {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    const people: [string, string | null][] = [
      ["asker", "Asker"], ["jonfreeholder", "Jon"], ["freeda", null], ["lanefree", "Lane"],
      ["robin", "Freelance Robin"], ["freebot", "Free Bot"], ["gonefree", "Gone"], ["community", "Free Community"],
    ];
    for (const [name, display] of people) {
      await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, $2)`, [id(name), display]);
    }
    await db.query(`UPDATE site.users SET is_bot = true WHERE matrix_id = $1`, [id("freebot")]);
    await db.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [id("gonefree")]);
    // A recent session must not move anyone up: the order never says who was online.
    await db.query(`INSERT INTO site.user_sessions (matrix_id, mx_device_id, last_seen) VALUES ($1, 'D1', now())`, [id("robin")]);
    await fn((sql, params) => db.query(sql, params), db);
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
}

const names = (a: { people: { username: string }[] }) => a.people.map((p) => p.username);
const ids = (a: { people: { matrixId: string }[] }) => a.people.map((p) => p.matrixId);

test("anywhere in the name, username or display name, starts-with before contains, ties by id — never by activity", async (t) => {
  await withDb(t, async (q) => {
    const a = await resolvePeople(q, "free", ME, [SERVICE], OWN);
    assert.deepEqual(names(a), ["freeda", "robin", "jonfreeholder", "lanefree"],
      "starts with (freeda; robin's 'Freelance Robin'), then holds it — each group by Matrix id, robin's fresh session moving nothing");
    assert.equal(a.exact, false, "a near match is never exact: the picker asks");
    assert.ok(!names(a).includes("freebot"), "never a bot");
    assert.ok(!names(a).includes("gonefree"), "never a deleted account");
    assert.ok(!names(a).includes("community"), "never the install's own account");
  });
});

test("case does not matter; the display name counts like the username", async (t) => {
  await withDb(t, async (q) => {
    assert.deepEqual(names(await resolvePeople(q, "LANCE", ME, [], OWN)), ["robin"]);
    const jon = await resolvePeople(q, "jon", ME, [], OWN);
    assert.deepEqual(names(jon), ["jonfreeholder"], "an exact display name, one account");
    assert.equal(jon.exact, false, "a display name is never sent to without asking: the picker shows the id");
  });
});

test("an exact username or a full Matrix id is that one person, outright", async (t) => {
  await withDb(t, async (q) => {
    const a = await resolvePeople(q, "lanefree", ME, [], OWN);
    assert.deepEqual(names(a), ["lanefree"]);
    assert.equal(a.exact, true);
    const full = await resolvePeople(q, id("freeda"), ME, [], OWN);
    assert.deepEqual(names(full), ["freeda"]);
    assert.equal(full.exact, true);
    assert.deepEqual(names(await resolvePeople(q, "@freeda", ME, [], OWN)), ["freeda"], "a leading @ is not part of the name");
  });
});

test("two accounts sharing a username → the picker with both full ids, never an auto-open", async (t) => {
  await withDb(t, async (q, db) => {
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Lane elsewhere')`, [id("lanefree", "other.example")]);
    const a = await resolvePeople(q, "lanefree", ME, [], OWN);
    assert.deepEqual(ids(a), [id("lanefree"), id("lanefree", "other.example")], "both, by id");
    assert.equal(a.exact, false);
    // The same for a display name two accounts share.
    await db.query(`UPDATE site.users SET display_name = 'Jon' WHERE matrix_id = $1`, [id("freeda")]);
    const k = await resolvePeople(q, "jon", ME, [], OWN);
    assert.equal(k.exact, false);
    assert.equal(k.people.length, 2);
  });
});

test("@name:server is exact only as that full id: another server's same localpart is asked, not opened", async (t) => {
  await withDb(t, async (q) => {
    const a = await resolvePeople(q, "@lanefree:other.example", ME, [], OWN);
    assert.equal(a.exact, false, "no such account: never the local lanefree outright");
    assert.deepEqual(names(a), ["lanefree"], "offered in the picker, with its full id");
  });
});

test("name:server without its @ is still an id: never the local account of that username", async (t) => {
  await withDb(t, async (q) => {
    const a = await resolvePeople(q, "lanefree:other.example", ME, [], OWN);
    assert.equal(a.exact, false, "the typed server is not this one: no auto-send to @lanefree:dmfind.test");
    const own = await resolvePeople(q, "lanefree:dmfind.test", ME, [], OWN);
    assert.deepEqual(names(own), ["lanefree"]);
    assert.equal(own.exact, true, "the full id, typed without its @, is that account");
  });
});

test("one character finds only an exact name, never a partial one", async (t) => {
  await withDb(t, async (q, db) => {
    assert.deepEqual(names(await resolvePeople(q, "f", ME, [], OWN)), [], "no partial rows for one letter");
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, NULL)`, [id("f")]);
    const exact = await resolvePeople(q, "f", ME, [], OWN);
    assert.deepEqual(names(exact), ["f"]);
    assert.equal(exact.exact, true);
  });
});

test("never yourself; nothing for nothing; at most 8", async (t) => {
  await withDb(t, async (q, db) => {
    assert.deepEqual(names(await resolvePeople(q, "asker", ME, [], OWN)), []);
    assert.deepEqual(names(await resolvePeople(q, "   ", ME, [], OWN)), []);
    for (let i = 0; i < 12; i++) await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Many')`, [id(`many${i}`)]);
    assert.equal((await resolvePeople(q, "many", ME, [], OWN)).people.length, 8);
  });
});

test("LIKE characters are plain text: % and _ match only themselves", async (t) => {
  await withDb(t, async (q) => {
    assert.deepEqual(names(await resolvePeople(q, "%%", ME, [], OWN)), []);
    assert.deepEqual(names(await resolvePeople(q, "__", ME, [], OWN)), []);
  });
});

test("a display name equal to another account's username is a tie: the picker shows both, nothing is sent", async (t) => {
  await withDb(t, async (q, db) => {
    await db.query(`UPDATE site.users SET display_name = 'freeda' WHERE matrix_id = $1`, [id("lanefree")]);
    const a = await resolvePeople(q, "freeda", ME, [], OWN);
    assert.deepEqual(names(a), ["freeda", "lanefree"], "the username first, then the display name");
    assert.equal(a.exact, false);
  });
});

test("another server's username, alone, still goes to the picker", async (t) => {
  await withDb(t, async (q, db) => {
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, NULL)`, [id("solo", "other.example")]);
    const a = await resolvePeople(q, "solo", ME, [], OWN);
    assert.deepEqual(ids(a), [id("solo", "other.example")]);
    assert.equal(a.exact, false);
  });
});

test("an over-long query is refused, never cut to a shorter one that could name someone else", async (t) => {
  await withDb(t, async (q) => {
    const long = `@lanefree:${"x".repeat(300)}`;
    assert.deepEqual(await resolvePeople(q, long, ME, [], OWN), { people: [], exact: false });
    assert.deepEqual(await resolvePeople(q, "lanefree" + " ".repeat(10) , ME, [], OWN).then((a) => a.exact), true, "surrounding spaces are not length");
  });
});
