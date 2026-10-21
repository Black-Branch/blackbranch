// The sign-in hand-off is bound to the browser that signed in.
//
// The sign-in callbacks finish by sending the browser to /auth/federated-complete?token=…, whose
// page redeems the one-time token for the Auth.js cookie. Without this binding, the token alone is
// enough: someone who completed a sign-in to THEIR OWN account and sent the link on could make
// another browser sign in as them (login CSRF) — the victim then acts, posts or pays under the
// attacker's account. So the callback also sets a per-token httpOnly cookie holding a secret, the
// pending row is keyed by a hash of link token AND secret, and the redeem needs both, atomically.
//
// Run: node --test app/lib/loginHandoff.test.ts   (with SQL_PARSE_DATABASE_URL for the real-schema case)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { createLoginHandoff, consumeLoginHandoff } from "./loginHandoff.ts";

const webRoot = join(import.meta.dirname, "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));

const ATTACKER = "@mallory:site.test";
const SID = "0b5f3d1e-8c2a-4f6e-9d7b-1a2c3e4f5a6b";

type Row = { token: string; matrix_id: string; session_id: string | null };

/** site.federated_pending ⋈ site.users, answering the hand-off's two statements. */
function fakeDb() {
  const rows: Row[] = [];
  const query = async (sql: string, params: unknown[]) => {
    if (/^INSERT INTO site\.federated_pending/.test(sql.trim())) {
      const [token, matrix_id, session_id] = params as [string, string, string | null];
      rows.push({ token, matrix_id, session_id });
      return { rows: [] };
    }
    assert.match(sql, /DELETE FROM site\.federated_pending fp[\s\S]*fp\.token = \$1 AND fp\.expires_at > NOW\(\)/, "the redeem is not one keyed, expiring delete");
    const [key] = params as [string];
    const i = rows.findIndex((r) => r.token === key);
    if (i < 0) return { rows: [] };
    const r = rows.splice(i, 1)[0] as Row;
    return { rows: [{ matrix_id: r.matrix_id, session_id: r.session_id, display_name: "mallory" }] };
  };
  return { rows, query };
}

/** The Cookie header a browser holding exactly these cookies would send to the redeem. */
const cookieHeader = (...cookies: { name: string; value: string }[]) => cookies.map((c) => `${c.name}=${c.value}`).join("; ");

test("browser B cannot redeem browser A's sign-in link — and A's own completion still works after B tried", async () => {
  const db = fakeDb();
  const a = await createLoginHandoff(ATTACKER, SID, db.query);

  // B is sent A's link: same token, but none of A's cookies.
  assert.equal(await consumeLoginHandoff(a.token, null, db.query), null, "a bare token signed browser B in");
  assert.equal(await consumeLoginHandoff(a.token, "", db.query), null);
  assert.equal(await consumeLoginHandoff(a.token, cookieHeader({ name: "authjs.csrf-token", value: "x" }), db.query), null);
  // B started a sign-in of its own: its cookie is for ITS token, not A's.
  const b = await createLoginHandoff("@casey:site.test", null, db.query);
  assert.equal(await consumeLoginHandoff(a.token, cookieHeader(b.cookie), db.query), null, "another hand-off's cookie redeemed this one");
  // B forges a cookie under A's token's name.
  assert.equal(await consumeLoginHandoff(a.token, cookieHeader({ name: a.cookie.name, value: b.cookie.value }), db.query), null, "a guessed secret redeemed the link");
  assert.equal(db.rows.filter((r) => r.matrix_id === ATTACKER).length, 1, "a refused redeem consumed the row");

  // A, the browser that signed in, completes.
  const user = await consumeLoginHandoff(a.token, cookieHeader({ name: "other", value: "1" }, a.cookie), db.query);
  assert.deepEqual(user, { id: ATTACKER, name: "mallory", sessionId: SID });
  assert.equal(await consumeLoginHandoff(a.token, cookieHeader(a.cookie), db.query), null, "the hand-off is single-use");
});

test("the binding cookie: httpOnly, Secure, Lax, two minutes, sent only to the redeem; the row is keyed by a hash of link AND secret", async () => {
  const db = fakeDb();
  const h = await createLoginHandoff(ATTACKER, SID, db.query);
  const HANDOFF_PATH = "/api/auth/callback/federated-completion"; // next-auth/react signIn("federated-completion") posts here
  assert.deepEqual(h.cookie.options, { httpOnly: true, secure: true, sameSite: "lax", path: HANDOFF_PATH, maxAge: 120 });
  assert.match(h.cookie.value, /^[A-Za-z0-9_-]{43}$/, "the secret is not 32 random bytes");
  assert.ok(h.cookie.name.endsWith(h.token), "one cookie per hand-off, so two sign-ins in one browser do not overwrite each other");
  const row = db.rows[0] as Row;
  assert.match(row.token, /^[0-9a-f]{64}$/, "the row is not keyed by a hash");
  assert.ok(row.token !== h.token && row.token !== h.cookie.value, "the row is keyed by the link token or the secret in the clear");
  const { createHash } = await import("node:crypto");
  assert.notEqual(row.token, createHash("sha256").update(h.token).digest("hex"), "the key is derivable from the link alone");
});

test("malformed tokens never reach the database", async () => {
  let asked = 0;
  const q = async () => { asked++; return { rows: [] }; };
  for (const t of [undefined, null, 42, "", "x", "'; DROP TABLE x; --", { a: 1 }]) {
    assert.equal(await consumeLoginHandoff(t, "a=b", q), null);
  }
  assert.equal(asked, 0);
});

test("both sign-in callbacks hand off through createLoginHandoff and set its cookie — no unbound INSERT is left", () => {
  for (const cb of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
    const src = read(cb);
    assert.match(src, /const handoff = await createLoginHandoff\(matrixId, sessionRows\[0\]\.session_id\);\s*const pendingToken = handoff\.token;\s*cookieStore\.set\(handoff\.cookie\.name, handoff\.cookie\.value, handoff\.cookie\.options\);/,
      `${cb}: the hand-off is not created with its binding cookie`);
    assert.doesNotMatch(src, /INSERT INTO site\.federated_pending/, `${cb}: a pending row is written without a binding`);
    assert.match(src, /federated-complete\?token=\$\{pendingToken\}[\s\S]*\}\s*$/, `${cb}: vacuity — the end of the file was not read`);
  }
  const auth = read("auth.ts");
  assert.match(auth, /async authorize\(credentials, request\) \{\s*return consumeLoginHandoff\(credentials\?\.token, request\.headers\.get\("cookie"\)\);/,
    "the completion provider no longer redeems through the bound hand-off");
  assert.doesNotMatch(auth, /DELETE FROM site\.federated_pending/, "an unbound redeem is back in auth.ts");
});

test("the real schema: an unbound row is never redeemed, a bound one only with its secret", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const who = "@s6test-mallory:site.test";
  const clean = async () => {
    await db.query(`DELETE FROM site.federated_pending WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
  };
  await clean();
  try {
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'mallory')`, [who]);
    const q = (sql: string, params: unknown[]) => db.query(sql, params);
    // A row written before the binding existed (a deploy-time leftover, keyed by the bare link
    // token): never redeemable, whatever cookie comes with it.
    const legacy = "11111111-2222-4333-8444-555555555555";
    await db.query(`INSERT INTO site.federated_pending (token, matrix_id) VALUES ($1, $2)`, [legacy, who]);
    assert.equal(await consumeLoginHandoff(legacy, `x=y`, q), null);
    assert.equal(await consumeLoginHandoff(legacy, `bb_handoff_${legacy}=anything`, q), null);
    assert.equal((await db.query(`SELECT 1 FROM site.federated_pending WHERE token = $1`, [legacy])).rowCount, 1);

    const h = await createLoginHandoff(who, null, q);
    assert.equal(await consumeLoginHandoff(h.token, null, q), null);
    assert.equal(await consumeLoginHandoff(h.token, cookieHeader({ name: h.cookie.name, value: "A".repeat(43) }), q), null);
    assert.deepEqual(await consumeLoginHandoff(h.token, cookieHeader(h.cookie), q), { id: who, name: "mallory", sessionId: undefined });
    assert.equal(await consumeLoginHandoff(h.token, cookieHeader(h.cookie), q), null, "redeemed twice");

    const expired = await createLoginHandoff(who, null, q);
    // Its row is the only one of this account's left besides the legacy one (keyed by the hash).
    const aged = await db.query(`UPDATE site.federated_pending SET expires_at = now() - interval '1 second' WHERE matrix_id = $1 AND token <> $2`, [who, legacy]);
    assert.equal(aged.rowCount, 1);
    assert.equal(await consumeLoginHandoff(expired.token, cookieHeader(expired.cookie), q), null, "an expired hand-off was redeemed");
  } finally {
    await clean();
    await db.end();
  }
});
