// A site cookie authorizes only while its sign-in row lives.
//
// The Auth.js cookie is a stateless JWT: before this check, logging out or revoking a session
// deleted its site.user_sessions row and its Matrix tokens, yet a COPY of the cookie went on
// authorizing every site API until the JWT expired (90 days). The session callback is the one
// seam every auth() passes through — ordinary routes, requireUser, requireMod/requireAdmin and
// the proxy — so the replay is driven through that callback's body (auth.ts cannot be imported
// under node --test), against an in-memory table and, where SQL_PARSE_DATABASE_URL names a
// replayed throwaway database, against the real schema.
//
// Run: node --test app/lib/siteSession.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { sessionFromToken, authRefusal } from "./siteSession.ts";
import { markAccountDeleted } from "./deletedAccounts.ts";

const webRoot = join(import.meta.dirname, "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));

const ME = "@casey:site.test";
const SID = "6f1c1e0a-2b7d-4c55-9a51-3c1f0d5e9b11";
/** Every server admitted: these tests are about the row; the sign-in policy has its own below. */
const ALLOW = () => true;

/** A tiny site.user_sessions ⋈ site.users that answers the callback's one query. */
function fakeDb() {
  const sessions = new Map<string, string>(); // session_id → matrix_id
  const deleted = new Set<string>();
  let down = false;
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[]) => {
    queries.push(sql);
    if (down) throw new Error("connect ECONNREFUSED");
    assert.match(sql, /FROM site\.user_sessions s JOIN site\.users u/, "the callback asked something else");
    const [sid, mx] = params as [string, string];
    return { rows: sessions.get(sid) === mx ? [{ deleted: deleted.has(mx) }] : [] };
  };
  return { sessions, deleted, queries, query, setDown: (v: boolean) => { down = v; } };
}

const freshSession = () => ({ user: { name: "casey" } as { name: string; id?: string }, expires: "2099-01-01T00:00:00.000Z" }) as Parameters<typeof sessionFromToken>[0];
/** What requireUser / requireMod answer for this session (their guard line, asserted below). */
const status = (s: Awaited<ReturnType<typeof sessionFromToken>>) => (s.user.id ? 200 : authRefusal(s)?.status ?? 401);

test("a copied cookie stops authorizing the moment its sign-in is logged out", async () => {
  const db = fakeDb();
  db.sessions.set(SID, ME);
  const token = { sub: ME, sessionId: SID };
  const live = await sessionFromToken(freshSession(), token, db.query, ALLOW);
  assert.equal(live.user.id, ME, "a live sign-in must authenticate");
  assert.equal(live.sessionId, SID);
  assert.equal(status(live), 200);

  // destroyMatrixSession(): the row goes (upstream logout is the network half, not modelled).
  db.sessions.delete(SID);
  const replay = await sessionFromToken(freshSession(), token, db.query, ALLOW);
  assert.equal(replay.user.id, undefined, "the copied cookie still names a user after logout");
  assert.equal(replay.authState, "revoked");
  assert.equal(status(replay), 401, "an ordinary or privileged guard must refuse the replay");
});

test("remote revocation (the refresh grant refused → row deleted) ends the cookie the same way", async () => {
  const db = fakeDb();
  db.sessions.set(SID, ME);
  // matrixSession.resolve() deletes the row on invalid_grant; the cookie is untouched.
  db.sessions.clear();
  const s = await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW);
  assert.equal(s.user.id, undefined);
  assert.equal(s.authState, "revoked");
});

test("a session row is good only for the account it belongs to", async () => {
  const db = fakeDb();
  db.sessions.set(SID, "@someone-else:site.test");
  const s = await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW);
  assert.equal(s.user.id, undefined, "a JWT for one account borrowed another account's live row");
});

test("re-authentication rotates the session id, so the cookie from before it dies", () => {
  for (const cb of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
    const src = read(cb);
    const at = src.indexOf("INSERT INTO site.user_sessions");
    assert.ok(at > 0, `${cb}: the session upsert was not read`);
    const up = src.slice(at, src.indexOf("RETURNING session_id", at));
    assert.match(up, /ON CONFLICT \(matrix_id, mx_device_id\) DO UPDATE SET\s+session_id\s+= gen_random_uuid\(\),/,
      `${cb}: a re-sign-in on the same device keeps the old session id, so a cookie copied before it stays live`);
  }
});

test("a JWT without a session id (issued before per-session rows) is revoked, not waved through", async () => {
  const db = fakeDb();
  for (const sessionId of [undefined, null, "", "not-a-uuid", 42]) {
    const s = await sessionFromToken(freshSession(), { sub: ME, sessionId }, db.query, ALLOW);
    assert.equal(s.user.id, undefined, String(sessionId));
    assert.equal(s.authState, "revoked", String(sessionId));
  }
  assert.equal(db.queries.length, 0, "a malformed id must not reach the database (a non-uuid would error as 'unavailable')");
});

test("a database error fails CLOSED — no user, and the guards answer 503, not 200 and not a sign-out", async () => {
  const db = fakeDb();
  db.sessions.set(SID, ME);
  db.setDown(true);
  const s = await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW);
  assert.equal(s.user.id, undefined, "an outage authenticated the cookie without checking it");
  assert.equal(s.authState, "unavailable");
  const r = authRefusal(s);
  assert.equal(r?.status, 503);
  assert.equal(r?.headers.get("Retry-After"), "5");
  // The callback must not THROW: @auth/core clears the session cookie when it does, which would
  // sign every viewer out over a database blip.
  db.setDown(false);
  assert.equal((await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW)).user.id, ME, "the cookie must still work once the database is back");
});

test("a deleted account authenticates nothing — by its tombstone, and at once in the deleting process", async () => {
  const db = fakeDb();
  db.sessions.set(SID, ME);
  db.deleted.add(ME);
  assert.equal((await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW)).user.id, undefined);

  const other = "@deltest-marked-s1:site.test";
  db.sessions.set(SID, other);
  db.deleted.clear();
  markAccountDeleted(other);
  assert.equal((await sessionFromToken(freshSession(), { sub: other, sessionId: SID }, db.query, ALLOW)).user.id, undefined);
});

test("one indexed query per auth() — the session's primary key, joined to its user", async () => {
  const db = fakeDb();
  db.sessions.set(SID, ME);
  await sessionFromToken(freshSession(), { sub: ME, sessionId: SID }, db.query, ALLOW);
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0] ?? "", /WHERE s\.session_id = \$1 AND s\.matrix_id = \$2/);
});

test("every auth() runs the check: the session callback IS sessionFromToken, and the Matrix token route reports a dead row as revoked", () => {
  const authSrc = read("auth.ts");
  assert.match(authSrc, /async session\(\{ session, token \}\) \{\s*return sessionFromToken\(session, token\);\s*\}/,
    "the session callback no longer goes through sessionFromToken");
  assert.doesNotMatch(authSrc, /isAccountDeleted/, "a second, fail-open deleted check is back in the callback");
  const guard = read("app/lib/authGuard.ts");
  assert.match(guard, /if \(!session\?\.user\?\.id\) return authRefusal\(session\) \?\? new Response\("Unauthorized", \{ status: 401 \}\);/);
  const admin = read("app/lib/admin.ts");
  assert.match(admin, /export async function requireMod\(\)[\s\S]*?if \(!session\?\.user\?\.id\) return authRefusal\(session\) \?\? new Response\("Unauthorized", \{ status: 401 \}\);/);
  // The browser's revoked-session path (wipe crypto stores + sign out — matrix-crypto.md) keys on
  // the token route's reason "revoked"; a revoked cookie must keep reaching it.
  const mx = read("app/lib/matrixSession.ts");
  assert.match(mx, /if \(session\?\.authState === "revoked"\) throw new RevokedSessionError\(\);/);
  assert.match(mx, /export async function destroyMatrixSession/, "vacuity: the end of matrixSession.ts was read");
});

test("the real schema: the callback's query answers live / revoked / deleted on Postgres", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const who = "@s1test-casey:site.test";
  const clean = async () => {
    await db.query(`DELETE FROM site.user_sessions WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
  };
  await clean();
  try {
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'casey')`, [who]);
    const sid = (await db.query(`INSERT INTO site.user_sessions (matrix_id, mx_device_id) VALUES ($1, 'S1TESTDEV') RETURNING session_id`, [who])).rows[0].session_id as string;
    const q = (sql: string, params: unknown[]) => db.query(sql, params);
    const siteSessionState = async (sub: string, sessionId: string, query: typeof q) => {
      const s = await sessionFromToken(freshSession(), { sub, sessionId }, query, ALLOW);
      return s.user.id ? "live" : s.authState;
    };
    assert.equal(await siteSessionState(who, sid, q), "live");
    assert.equal(await siteSessionState("@s1test-other:site.test", sid, q), "revoked");
    await db.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [who]);
    assert.equal(await siteSessionState(who, sid, q), "revoked");
    await db.query(`UPDATE site.users SET deleted_at = NULL WHERE matrix_id = $1`, [who]);
    // Re-sign-in on the same device, with each callback's own upsert (read from the route): the
    // row survives with a NEW id, so the cookie bound to the old one is revoked.
    let current = sid;
    for (const cb of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
      const upsert = /`(INSERT INTO site\.user_sessions[\s\S]*?RETURNING session_id)`/.exec(readFileSync(join(webRoot, cb), "utf8"))?.[1];
      assert.ok(upsert, `${cb}: the upsert was not found`);
      const next = (await db.query(upsert, [who, "S1TESTDEV", null, null, 0])).rows[0].session_id as string;
      assert.notEqual(next, current, `${cb}: the session id survived a re-sign-in`);
      assert.equal(await siteSessionState(who, current, q), "revoked", `${cb}: the pre-re-sign-in cookie is still live`);
      assert.equal(await siteSessionState(who, next, q), "live");
      current = next;
    }
    await db.query(`DELETE FROM site.user_sessions WHERE session_id = $1`, [current]);
    assert.equal(await siteSessionState(who, current, q), "revoked");
  } finally {
    await clean();
    await db.end();
  }
});
