// Self-serve "Delete my account":
//   • the site erase on a REAL Postgres: what is removed, what is tombstoned, what is KEPT (a ban,
//     payment rows without a name, the ledger), and someone else's data untouched;
//   • the route acts only on the session's own account, same-origin, and every refusal (name,
//     fresh sign-in, subscription, admin) comes before the first write.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/accountDeletion.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { accountNameOf, confirmsName, eraseSiteData, restrictionExpiry, DELETION_DECLARATION } from "./accountDeletion.ts";
import { noOptOutSql } from "./linkConsent.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));
/** A stripped read whose END is proven present: the raw file's last code line must close the
 *  stripped text, so a stripper or a read that lost the tail fails here, not vacuously below. */
const readWhole = (p: string) => {
  const raw = readFileSync(join(webRoot, p), "utf8");
  const src = stripComments(raw);
  const lines = raw.trimEnd().split("\n");
  let tail = "";
  for (let i = lines.length - 1; i >= 0 && tail.trim().length < 40; i--) tail = lines.slice(i).join("\n");
  assert.ok(tail.trim().length >= 40 && src.trimEnd().endsWith(tail), `${p}: the scan lost the end of the file`);
  return src;
};

test("the confirm name: the account's local name, typed exactly (case and a leading @ forgiven)", () => {
  assert.equal(accountNameOf("@kate:example.tv"), "kate");
  assert.equal(confirmsName("kate", "@kate:example.tv"), true);
  assert.equal(confirmsName(" @Kate ", "@kate:example.tv"), true);
  assert.equal(confirmsName("kat", "@kate:example.tv"), false);
  assert.equal(confirmsName("@kate:example.tv", "@kate:example.tv"), false, "the full id is not the name asked for");
  assert.equal(confirmsName(undefined, "@kate:example.tv"), false);
});

// Review round 5: a TIMEOUT's restriction on the deleted account's platform ids ends when the
// timeout does. A permanent ban, or any open case, keeps it with no end.
test("the restriction a deletion leaves ends with a timeout — never with a permanent ban or an open case", () => {
  const none = { mark: false, held: false, report: false };
  const end = "2026-10-18T12:10:00.000Z";
  assert.equal(restrictionExpiry({ banned: true, banEndsAt: end, openCases: none }), end);
  assert.equal(restrictionExpiry({ banned: true, banEndsAt: null, openCases: none }), null, "a permanent ban ended");
  for (const k of ["mark", "held", "report"] as const) {
    assert.equal(restrictionExpiry({ banned: true, banEndsAt: end, openCases: { ...none, [k]: true } }), null, `an open ${k} ended with the timeout`);
  }
  assert.equal(restrictionExpiry({ banned: false, banEndsAt: null, openCases: { ...none, report: true } }), null);
  const src = readWhole("app/lib/accountDeletion.ts");
  assert.match(src, /restrictionExpiresAt: restrictionExpiry\(check\)/, "deleteAccount does not send the end to stream-api");
});

test("the route deletes only the session's own account, same-origin, with no target parameter", () => {
  const src = read("app/api/me/delete-account/route.ts");
  assert.match(src, /export async function POST\(req: NextRequest\) \{\n\s*if \(!sameOriginRequest\(req\.headers\)\) return/);
  assert.match(src, /deleteAccount\(who\.matrixId, who\.sessionId, body\?\.name\)/);
  assert.doesNotMatch(src, /body\?\.(matrixId|target|id)\b/, "the route takes a target from the request");
  assert.match(src, /const matrixId = session\?\.user\?\.id;/);
});

test("every refusal comes before the first write, in deleteAccount itself", () => {
  const src = read("app/lib/accountDeletion.ts");
  const fn = src.slice(src.indexOf("export async function deleteAccount"));
  const firstWrite = fn.indexOf("INSERT INTO site.account_deletions");
  assert.ok(firstWrite > 0);
  for (const guard of ["confirmsName(typedName, matrixId)", "if (!check.fresh)", "if (check.activeSubscription)"]) {
    const at = fn.indexOf(guard);
    assert.ok(at > 0 && at < firstWrite, `${guard} is missing or comes after a write`);
  }
  assert.ok(fn.indexOf('"/account/erase"') < fn.indexOf("eraseSiteData(client"), "the AI memory must go while the identity links still exist");
  assert.match(src, /export const FRESH_MS = 15 \* 60_000;/);
});

test("freshness is the session's own SIGN-IN time: set only by the sign-in callbacks, never by a token refresh", () => {
  const lib = read("app/lib/accountDeletion.ts");
  assert.match(lib, /SELECT signed_in_at FROM site\.user_sessions WHERE session_id = \$1 AND matrix_id = \$2/);
  assert.match(lib, /now - signedIn\.getTime\(\) <= FRESH_MS/);
  assert.doesNotMatch(lib, /created_at FROM site\.user_sessions|last_seen/, "freshness read from a column a refresh moves");
  for (const cb of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
    const src = read(cb);
    const up = src.slice(src.indexOf("INSERT INTO site.user_sessions"), src.indexOf("RETURNING session_id", src.indexOf("INSERT INTO site.user_sessions")));
    assert.match(up, /ON CONFLICT \(matrix_id, mx_device_id\) DO UPDATE SET[\s\S]*signed_in_at\s+= now\(\)/, `${cb}: a re-sign-in on the same device does not refresh signed_in_at`);
  }
  // Every other writer of site.user_sessions must leave signed_in_at alone.
  const refresh = readWhole("app/lib/matrixSession.ts");
  assert.match(refresh, /UPDATE site\.user_sessions/, "the refresh path was not read");
  assert.doesNotMatch(refresh, /signed_in_at/, "a token refresh moves the sign-in time — a refreshed session would read as fresh");
  const route = read("app/api/me/delete-account/route.ts");
  assert.match(route, /sessionId: \(session as \{ sessionId\?: string \} \| null\)\?\.sessionId \?\? null/, "the session id must come from the signed session");
});

test("nothing but an active subscription blocks a deletion — an open report, hold, mark or ban never does", () => {
  const lib = read("app/lib/accountDeletion.ts");
  const fn = lib.slice(lib.indexOf("export async function deleteAccount"), lib.indexOf("INSERT INTO site.account_deletions"));
  const refusals = fn.match(/return \{ ok: false/g) ?? [];
  assert.equal(refusals.length, 3, "a refusal was added beyond the name, the fresh sign-in and the subscription");
  assert.doesNotMatch(fn, /check\.banned\) return|openCases\.[a-z]+\) return|isAdmin\) return/, "an open case blocks the deletion");
  assert.match(fn, /evidence: check\.banned \|\| check\.openCases\.mark \|\| check\.openCases\.held \|\| check\.openCases\.report, links: check\.banned/);
  assert.match(lib, /site\.reports WHERE reported_id = \$1 AND status <> 'resolved'/);
  assert.match(lib, /JOIN site\.platform_links p ON p\.canonical_id = m\.canonical_id/);
  assert.match(lib, /body: JSON\.stringify\(\{ matrixId, keepEvidence: keep\.evidence, keepLinks: keep\.links, restrictionExpiresAt: restrictionExpiry\(check\) \}\)/, "the stream side is not told to keep the evidence");
  assert.match(lib, /eraseSiteData\(client, matrixId, keep\)/);
});

test("the erase never touches the moderation record: bans, mod log, reports, review rows, slow mode", () => {
  const fn = read("app/lib/accountDeletion.ts");
  const erase = fn.slice(fn.indexOf("export async function eraseSiteData"), fn.indexOf("export type DeletionResult"));
  for (const t of ["site.bans", "site.mod_log", "site.reports", "site.automod_held", "site.user_marks", "site.platform_mod_actions", "site.user_slow_mode", "site.coin_ledger", "site.payment_events"]) {
    assert.ok(!erase.includes(t), `the erase touches ${t}`);
  }
  assert.match(erase, /DELETE FROM site\.accounts WHERE matrix_id = \$1/, "vacuity: the erase body was read");
});

test("the site erase on a real Postgres: removed, tombstoned, kept — and nobody else touched", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const me = "@deltest-me:x";
  const other = "@deltest-other:x";
  const clean = async () => {
    await db.query(`DELETE FROM site.pinned_messages WHERE message_id IN (SELECT id FROM site.chat_messages WHERE matrix_id IN ($1, $2))`, [me, other]);
    await db.query(`DELETE FROM site.chat_messages WHERE matrix_id IN ($1, $2)`, [me, other]);
    await db.query(`DELETE FROM site.coin_earn_upvotes WHERE recipient IN ($1, $2) OR voter IN ($1, $2)`, [me, other]);
    for (const tbl of ["bans", "donations", "coin_ledger", "coin_wallets", "user_sessions", "user_settings", "badge_slots", "message_votes", "platform_links", "accounts", "user_marks"]) {
      const col = tbl === "message_votes" ? "voter_matrix_id" : "matrix_id";
      await db.query(`DELETE FROM site.${tbl} WHERE ${col} IN ($1, $2)`, [me, other]);
    }
    await db.query(`DELETE FROM site.mod_log WHERE target_id = $1 AND reason = 'deltest'`, [me]);
    await db.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [me, other]);
  };
  await clean();
  try {
    await db.query(`INSERT INTO site.users (matrix_id, display_name, email, bio, avatar_url, is_mod) VALUES ($1, 'Me Myself', 'me@x', 'my bio', 'mxc://a', true), ($2, 'Other', 'o@x', 'their bio', null, false)`, [me, other]);
    const mine = (await db.query(`INSERT INTO site.chat_messages (matrix_id, message, emotes) VALUES ($1, 'my secret line', '{"a":"b"}') RETURNING id`, [me])).rows[0].id;
    await db.query(`INSERT INTO site.chat_messages (matrix_id, message, reply_to_id, reply_to_username, reply_to_text) VALUES ($1, 'replying', $2, 'Me Myself', 'my secret line')`, [other, mine]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, reason) VALUES ($1, $2, 'spam')`, [me, other]);
    await db.query(`INSERT INTO site.donations (matrix_id, display_name, message, amount_cents, currency, status) VALUES ($1, 'Me Myself', 'love the stream', 500, 'usd', 'paid')`, [me]);
    await db.query(`INSERT INTO site.coin_wallets (matrix_id, balance) VALUES ($1, 420), ($2, 99)`, [me, other]);
    await db.query(`UPDATE site.pinned_messages SET active = FALSE WHERE active`);
    await db.query(`INSERT INTO site.pinned_messages (platform, message_id, username, message, active) VALUES ('native', $1, 'Me Myself', 'my secret line', true)`, [mine]);
    await db.query(`INSERT INTO site.user_sessions (session_id, matrix_id, mx_device_id) VALUES (gen_random_uuid(), $1, 'D1'), (gen_random_uuid(), $2, 'D2')`, [me, other]);
    await db.query(`INSERT INTO site.mod_log (action, target_id, performed_by, reason) VALUES ('ban', $1, $2, 'deltest')`, [me, other]);
    await db.query(`INSERT INTO site.user_settings (matrix_id, settings) VALUES ($1, '{}'::jsonb)`, [me]);
    await db.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-del-1', 'deltestcanon')`, [me]);
    await db.query(`INSERT INTO site.accounts (id, matrix_id, type, provider, provider_account_id, access_token) VALUES ('deltest-acc', $1, 'oauth', 'twitch', 'tw-del-1', 'tok')`, [me]);
    await db.query(`INSERT INTO site.message_votes (platform, message_id, voter_matrix_id, vote) VALUES ('native', '1', $1, 1)`, [me]);
    await db.query(`INSERT INTO site.coin_earn_upvotes (recipient, voter, stream_id, paid) VALUES ($2, $1, 1, 1), ($1, $2, 1, 1), ($2, '@deltest-third:x', 1, 1)`, [me, other]);
    await db.query(`INSERT INTO site.user_marks (matrix_id, reason, source, created_by, cleared_at, cleared_by) VALUES ($1, 'x', 'automod', 'automod', now(), 'mod')`, [me]);

    await db.query("BEGIN");
    const n = await eraseSiteData(db, me);
    await db.query("COMMIT");

    const pin = (await db.query(`SELECT active, message, username FROM site.pinned_messages WHERE platform = 'native' AND message_id = $1`, [mine])).rows[0];
    assert.deepEqual([pin.active, pin.message, pin.username], [false, "", "Deleted account"], "a pin of their message is still up, or keeps their words");
    const u = (await db.query(`SELECT display_name, email, bio, avatar_url, is_mod, deleted_at FROM site.users WHERE matrix_id = $1`, [me])).rows[0];
    assert.deepEqual([u.display_name, u.email, u.bio, u.avatar_url, u.is_mod, !!u.deleted_at], ["Deleted account", null, null, null, false, true], "the account row is not a tombstone");
    const msg = (await db.query(`SELECT message, emotes, is_deleted FROM site.chat_messages WHERE id = $1`, [mine])).rows[0];
    assert.deepEqual([msg.message, msg.emotes, msg.is_deleted], ["", null, true], "their message kept its text");
    const reply = (await db.query(`SELECT message, reply_to_id, reply_to_text, reply_to_username FROM site.chat_messages WHERE matrix_id = $1`, [other])).rows[0];
    assert.deepEqual([reply.message, Number(reply.reply_to_id), reply.reply_to_text, reply.reply_to_username], ["replying", Number(mine), null, null], "another person's reply still quotes them (or lost its own text)");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.bans WHERE matrix_id = $1`, [me])).rows[0].n, 1, "deleting the account lifted the ban");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.mod_log WHERE target_id = $1 AND reason = 'deltest'`, [me])).rows[0].n, 1, "the mod log lost its entry");
    const don = (await db.query(`SELECT display_name, message, amount_cents, anonymous FROM site.donations WHERE matrix_id = $1`, [me])).rows[0];
    assert.deepEqual([don.display_name, don.message, don.amount_cents, don.anonymous], [null, null, 500, true], "the payment record was lost or kept the name");
    assert.equal(Number((await db.query(`SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`, [me])).rows[0].balance), 0);
    assert.deepEqual((await db.query(`SELECT delta::int, kind FROM site.coin_ledger WHERE matrix_id = $1`, [me])).rows, [{ delta: -420, kind: "forfeit" }], "the forfeit is not in the ledger");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.user_marks WHERE matrix_id = $1`, [me])).rows[0].n, 1, "a (cleared) mark — moderation history — was deleted");
    for (const [tbl, col] of [["user_sessions", "matrix_id"], ["user_settings", "matrix_id"], ["platform_links", "matrix_id"], ["accounts", "matrix_id"], ["message_votes", "voter_matrix_id"]]) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.${tbl} WHERE ${col} = $1`, [me])).rows[0].n, 0, `site.${tbl} still holds their rows`);
    }
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.coin_earn_upvotes WHERE voter = $1 OR recipient = $1`, [me])).rows[0].n, 0, "their upvote tallies (given or received) were kept");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.coin_earn_upvotes WHERE recipient = $1`, [other])).rows[0].n, 1, "someone else's upvote tally was removed");
    assert.equal(n.pointsForfeited, 420);
    const them = (await db.query(`SELECT display_name, email, bio FROM site.users WHERE matrix_id = $1`, [other])).rows[0];
    assert.deepEqual(them, { display_name: "Other", email: "o@x", bio: "their bio" }, "someone else's profile changed");
    assert.equal(Number((await db.query(`SELECT balance FROM site.coin_wallets WHERE matrix_id = $1`, [other])).rows[0].balance), 99);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.user_sessions WHERE matrix_id = $1`, [other])).rows[0].n, 1);

    await db.query("BEGIN");
    const again = await eraseSiteData(db, me);
    await db.query("COMMIT");
    assert.equal(again.pointsForfeited, 0, "a second run forfeited again");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.coin_ledger WHERE matrix_id = $1`, [me])).rows[0].n, 1);
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await clean();
    await db.end();
  }
});

// ── Completeness: every per-person column of the site schema is declared ─────────────────────
// The erase is a hand-written list. A new per-person table or profile column used to ship with no
// one deciding whether a deletion removes it (payments, coins and slow mode were undeclared, and
// v153's show_links was left "consenting" on a tombstone). DELETION_DECLARATION says, per column,
// erased or kept (with a reason); this reads the GENERATED baseline schema and fails on any
// `site.*` column ending in matrix_id, or any `site.users` column, that is in none or in two.

type Schema = Map<string, string[]>;

/** `CREATE TABLE site.<t> ( <col> <type>, … );` blocks of a pg_dump, as table → columns. */
function siteTables(sql: string): Schema {
  const out: Schema = new Map();
  for (const m of sql.matchAll(/^CREATE TABLE site\.(\w+) \(\n([\s\S]*?)\n\);$/gm)) {
    const cols = m[2]!.split("\n").map((l) => /^ {4}(\w+) /.exec(l)?.[1]).filter((c): c is string => !!c && c !== "CONSTRAINT");
    out.set(m[1]!, cols);
  }
  return out;
}

function coverageProblems(schema: Schema, d: typeof DELETION_DECLARATION): string[] {
  const problems: string[] = [];
  const erased = new Set<string>(d.erased);
  const kept = new Set(Object.keys(d.kept));
  for (const [t, cols] of schema) {
    for (const c of cols) {
      if (!c.endsWith("matrix_id")) continue;
      const k = `${t}.${c}`;
      const n = (erased.has(k) ? 1 : 0) + (kept.has(k) ? 1 : 0);
      if (n !== 1) problems.push(`site.${k} is declared ${n === 0 ? "nowhere" : "twice"}`);
    }
  }
  for (const k of [...erased, ...kept]) {
    const [t, c] = k.split(".");
    if (!schema.get(t!)?.includes(c!)) problems.push(`declared site.${k} is not in the schema`);
    if (!d.kept[k as keyof typeof d.kept] && kept.has(k)) problems.push(`site.${k} is kept without a reason`);
  }
  const reset = new Set<string>(d.resetColumns);
  const keptCols = new Set(Object.keys(d.keptColumns));
  for (const c of schema.get("users") ?? []) {
    const n = (reset.has(c) ? 1 : 0) + (keptCols.has(c) ? 1 : 0);
    if (n !== 1) problems.push(`site.users.${c} is declared ${n === 0 ? "nowhere" : "twice"}`);
  }
  for (const c of [...reset, ...keptCols]) if (!(schema.get("users") ?? []).includes(c)) problems.push(`declared site.users.${c} is not in the schema`);
  return problems;
}

const BASELINE = readFileSync(join(webRoot, "..", "migrations", "baseline", "schema.sql"), "utf8");

test("every per-person column of the site schema is declared erased or kept, exactly once", () => {
  const schema = siteTables(BASELINE);
  // Vacuity: the parse found the site schema, and read site.users to its last column.
  assert.ok(schema.size >= 60, `only ${schema.size} site tables parsed`);
  assert.ok(schema.get("users")?.includes("show_links"), "site.users was not read to its end");
  assert.ok(schema.get("chat_messages")?.includes("matrix_id"));
  assert.deepEqual(coverageProblems(schema, DELETION_DECLARATION), []);
});

test("the completeness check fails for a new column nobody declared (mutation)", () => {
  const schema = siteTables(BASELINE);
  const withTable = new Map(schema).set("new_per_person_thing", ["id", "owner_matrix_id"]);
  assert.deepEqual(coverageProblems(withTable, DELETION_DECLARATION), ["site.new_per_person_thing.owner_matrix_id is declared nowhere"]);
  const withColumn = new Map(schema).set("users", [...schema.get("users")!, "favourite_colour"]);
  assert.deepEqual(coverageProblems(withColumn, DELETION_DECLARATION), ["site.users.favourite_colour is declared nowhere"]);
  const both = { ...DELETION_DECLARATION, kept: { ...DELETION_DECLARATION.kept, "accounts.matrix_id": "twice" } };
  assert.deepEqual(coverageProblems(schema, both as typeof DELETION_DECLARATION), ["site.accounts.matrix_id is declared twice"]);
});

test("the tombstone UPDATE writes exactly the declared reset columns, and every erased table is in the erase", () => {
  const lib = readWhole("app/lib/accountDeletion.ts");
  const erase = lib.slice(lib.indexOf("export async function eraseSiteData"), lib.indexOf("export const DELETION_DECLARATION"));
  const upd = /`UPDATE site\.users SET ([\s\S]*?) WHERE matrix_id = \$1`/.exec(erase);
  assert.ok(upd, "the tombstone UPDATE was not found");
  const set = upd[1]!.split(",").map((a) => a.trim().split(/\s*=/)[0]!.trim()).sort();
  assert.deepEqual(set, [...DELETION_DECLARATION.resetColumns].sort());
  for (const k of DELETION_DECLARATION.erased) {
    const t = k.split(".")[0]!;
    assert.ok(erase.includes(`site.${t} `) || erase.includes(`site.${t}\n`) || t === "coin_earn_upvotes" && erase.includes("site.coin_earn_upvotes"), `site.${t} is declared erased but the erase never names it`);
  }
});

test("a deleted account authenticates nothing: the session callback drops its id, so every guard answers 401", async () => {
  // The callback itself, and its deleted-account answers, are driven in siteSession.test.ts.
  const auth = read("auth.ts");
  assert.match(auth, /async session\(\{ session, token \}\) \{\s*return sessionFromToken\(session, token\);/,
    "the session callback no longer goes through the session check that refuses deleted accounts");
  assert.match(read("app/lib/siteSession.ts"), /SELECT u\.deleted_at IS NOT NULL AS deleted/, "the session check no longer reads the tombstone");
  assert.match(read("app/lib/authGuard.ts"), /if \(!session\?\.user\?\.id\) return authRefusal\(session\) \?\? new Response\("Unauthorized", \{ status: 401 \}\)/);
  const { isMarkedDeleted, markAccountDeleted } = await import("./deletedAccounts.ts");
  markAccountDeleted("@deltest-marked:x");
  assert.equal(isMarkedDeleted("@deltest-marked:x"), true, "a marked deletion was not final");
  const lib = read("app/lib/accountDeletion.ts");
  assert.ok(lib.indexOf("markAccountDeleted(matrixId)") > lib.indexOf('await client.query("COMMIT")'), "marked before the erase committed");
});

test("nothing is revoked until the erase commits: a stream-api outage leaves the person signed in, and the 502 says so", () => {
  const lib = readWhole("app/lib/accountDeletion.ts");
  const fn = lib.slice(lib.indexOf("export async function deleteAccount"));
  const at = (needle: string) => { const i = fn.indexOf(needle); assert.ok(i > 0, `deleteAccount lost ${needle}`); return i; };
  assert.ok(at('"/account/erase"') < at("readCredentials(client, matrixId)"), "credentials touched before the stream side answered");
  assert.ok(at("readCredentials(client, matrixId)") < at("eraseSiteData(client, matrixId, keep)"), "credentials read after their rows were deleted");
  assert.ok(at('await client.query("COMMIT")') < at("revokeAtIssuers(credentials)"), "credentials revoked before the erase committed");
  assert.ok(at('if (!res?.ok) return { ok: false, status: 502') < at("revokeAtIssuers(credentials)"));
  assert.doesNotMatch(lib, /nothing was deleted yet/, "the 502 claims nothing changed (the stream side may have run in part)");
  assert.match(lib, /your account was not deleted and you are still signed in/);
  const rc = lib.slice(lib.indexOf("async function readCredentials"), lib.indexOf("export type DeletionResult"));
  assert.match(rc, /FROM site\.user_sessions WHERE matrix_id = \$1/, "only one device's session revoked");
  assert.match(rc, /oauthRevoke\(refresh, "refresh_token"\)/);
  assert.match(rc, /oauthRevoke\(access, "access_token"\)/);
  assert.match(rc, /revokePlatformGrant\(/);
  assert.match(rc, /NOT EXISTS \(SELECT 1 FROM site\.accounts o WHERE o\.provider = a\.provider AND o\.provider_account_id = a\.provider_account_id AND o\.matrix_id <> \$1\)/, "a shared grant would be revoked at the provider");
});

test("a deleted account cannot sign in again: both callbacks ask before their first write and send it to a plain page", () => {
  for (const cb of ["app/api/auth/mas-callback/route.ts", "app/api/auth/matrix-callback/route.ts"]) {
    const src = readWhole(cb);
    const ask = src.indexOf("await accountDeletedForSignIn(matrixId)");
    assert.ok(ask > 0, `${cb} never asks whether the account was deleted`);
    for (const write of ["checkSignupAllowed(", "INSERT INTO site.users", "createIdentityResolver(", "INSERT INTO site.user_sessions", "createLoginHandoff("]) {
      const w = src.indexOf(write);
      assert.ok(w > ask, `${cb}: ${write} runs before the deleted check`);
    }
    const branch = src.slice(ask, src.indexOf("checkSignupAllowed("));
    assert.match(branch, /NextResponse\.redirect\(new URL\("\/auth\/deleted", BASE_URL\)\)/, `${cb}: a deleted account is not sent to the explanation page`);
    assert.match(branch, /\.catch\(\(\) => null\)/, `${cb}: a failed check must refuse, not let the sign-in through`);
  }
  const mas = readWhole("app/api/auth/mas-callback/route.ts");
  const branch = mas.slice(mas.indexOf("await accountDeletedForSignIn(matrixId)"), mas.indexOf("checkSignupAllowed("));
  assert.match(branch, /oauthRevoke\(tokens\.access_token, "access_token"\)/, "the session MAS just opened for a deleted account stays live");
  assert.match(branch, /oauthRevoke\(tokens\.refresh_token, "refresh_token"\)/);
  const page = readWhole("app/(main)/auth/deleted/page.tsx");
  assert.match(page, /This account was deleted/);
});

test("the sign-in check on a real Postgres: a tombstone is deleted, a live or unknown account is not, and an error throws", async (t) => {
  const { accountDeletedForSignIn } = await import("./deletedAccounts.ts");
  await assert.rejects(accountDeletedForSignIn("@x:y", async () => { throw new Error("db down"); }), /db down/, "a DB error must reach the caller (it refuses)");
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const gone = "@deltest-signin-gone:x";
  const live = "@deltest-signin-live:x";
  const q = (sql: string, params: unknown[]) => db.query(sql, params);
  try {
    await db.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [gone, live]);
    await db.query(`INSERT INTO site.users (matrix_id, display_name, deleted_at) VALUES ($1, 'Deleted account', now()), ($2, 'Live', NULL)`, [gone, live]);
    assert.equal(await accountDeletedForSignIn(gone, q), true, "a deleted account reads as live at sign-in");
    assert.equal(await accountDeletedForSignIn(live, q), false);
    assert.equal(await accountDeletedForSignIn("@deltest-signin-new:x", q), false, "a brand-new account reads as deleted");
  } finally {
    await db.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [gone, live]);
    await db.end();
  }
});

test("with an open report and an active ban: deleted anyway — the words kept for mods, the report and ban kept, the links still held", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const me = "@deltest-case:x";
  const reporter = "@deltest-reporter:x";
  const evader = "@deltest-evader:x";
  const clean = async () => {
    await db.query(`DELETE FROM site.reports WHERE reported_id = $1`, [me]);
    await db.query(`DELETE FROM site.chat_messages WHERE matrix_id = $1`, [me]);
    await db.query(`DELETE FROM site.bans WHERE matrix_id = $1`, [me]);
    await db.query(`DELETE FROM site.platform_links WHERE matrix_id IN ($1, $2)`, [me, evader]);
    await db.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2, $3)`, [me, reporter, evader]);
  };
  await clean();
  try {
    await db.query(`INSERT INTO site.users (matrix_id, display_name, show_links) VALUES ($1, 'Case', true), ($2, 'Reporter', false), ($3, 'Evader', false)`, [me, reporter, evader]);
    const msg = (await db.query(`INSERT INTO site.chat_messages (matrix_id, message) VALUES ($1, 'the abusive line the report is about') RETURNING id`, [me])).rows[0].id;
    await db.query(`INSERT INTO site.reports (reported_id, reporter_id, reason, status) VALUES ($1, $2, 'abuse', 'open')`, [me, reporter]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, reason) VALUES ($1, $2, 'abuse')`, [me, reporter]);
    await db.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-case-1', 'deltestcase')`, [me]);

    await db.query("BEGIN");
    await eraseSiteData(db, me, { evidence: true, links: true });
    await db.query("COMMIT");

    const m = (await db.query(`SELECT message, is_deleted FROM site.chat_messages WHERE id = $1`, [msg])).rows[0];
    assert.deepEqual([m.message, m.is_deleted], ["the abusive line the report is about", true], "the evidence was erased, or left public");
    assert.equal((await db.query(`SELECT display_name FROM site.users WHERE matrix_id = $1`, [me])).rows[0].display_name, "Deleted account", "the evidence is still attached to the profile");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.reports WHERE reported_id = $1 AND status = 'open'`, [me])).rows[0].n, 1, "the open report was removed");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.bans WHERE matrix_id = $1`, [me])).rows[0].n, 1, "the ban was lifted");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.platform_links WHERE matrix_id = $1`, [me])).rows[0].n, 1, "the banned identity's link was freed");
    // The kept link must not keep "consenting": the tombstone's opt-in is off, so the one consent
    // predicate answers no for the canonical it still holds.
    assert.equal((await db.query(`SELECT show_links FROM site.users WHERE matrix_id = $1`, [me])).rows[0].show_links, false, "a deleted opted-in person still shows their links");
    assert.equal((await db.query(`SELECT ${noOptOutSql("$1::text")} AS ok`, ["deltestcase"])).rows[0].ok, false, "the consent predicate still reads the tombstone as consenting");
    await assert.rejects(
      db.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-case-1', 'deltestcase')`, [evader]),
      /platform_links_platform_id_uq|duplicate key/, "a fresh account could re-link the banned platform identity");
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await clean();
    await db.end();
  }
});
