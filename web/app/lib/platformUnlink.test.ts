// Unlinking a platform account (DELETE /api/account-links → platformUnlink.ts) separates its stream
// identity through stream-api's REAL /identity/unlink, against a real Postgres:
//   • unlink → the platform account has a fresh identity, carrying the account's open mark;
//   • another site account then links it → its merge never reaches the first person;
//   • the same account links it again → it is that person's again;
//   • stream-api not answering → nothing is removed, 503.
// And the route goes through the helper.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/platformUnlink.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Pool } from "pg";
import { unlinkPlatformAccount, type UnlinkDeps } from "./platformUnlink.ts";
import { claimPlatformAccount } from "./platformAccountLink.ts";
import { stripComments } from "./testSource.ts";

const WEB = process.cwd();
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `pul${process.pid}x${Date.now().toString(36)}`;
const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");

type Res = { statusCode: number; body: { canonicalId?: string } | null };
type Identity = {
  registerIdentityRoutes: (app: unknown, mw: unknown) => void;
  gatherIdentity: (m: string) => Promise<string[]>;
  mergeCanonicals: (ids: string[]) => Promise<{ survivor: string | null }>;
};

test("unlink separates the stream identity: fresh + marked; another account's link never merges two people", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 4 });
  const A = `@${RUN}-a:site.test`;
  const B = `@${RUN}-b:site.test`;
  const TW = `${RUN}-tw`, KK = `${RUN}-kk`;
  const [cA, cB] = [hex(1), hex(2)];
  const minted = async () => (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE $1`, [`${RUN}%`])).rows.map((r) => r.canonical as string);
  const clean = async () => {
    const ids = [...new Set([cA, cB, ...(await minted())])];
    await pool.query(`DELETE FROM site.user_marks WHERE matrix_id IN ($1, $2) OR canonical_id = ANY($3)`, [A, B, ids]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id IN ($1, $2)`, [A, B]);
    await pool.query(`DELETE FROM site.accounts WHERE matrix_id IN ($1, $2)`, [A, B]);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1) OR platform_id LIKE $2`, [ids, `${RUN}%`]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.bot_impressions WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [A, B]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  // A: no native row — two platform accounts merged onto cA, so stream-api's ownership check can
  // only read site.platform_links (the order the helper must keep). An open mark on the account.
  await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'alpha'), ($2, 'bravo')`, [A, B]);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'alpha'), ($2, 'bravo')`, [cA, cB]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', $1, $3), ('kick', $2, $3), ('native', $4, $5)`, [TW, KK, cA, B, cB]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $4), ($1, 'kick', $3, $4)`, [A, TW, KK, cA]);
  await pool.query(`INSERT INTO site.accounts (matrix_id, type, provider, provider_account_id, access_token) VALUES ($1, 'oauth', 'twitch', $2, 'enc'), ($1, 'oauth', 'kick', $3, 'enc')`, [A, TW, KK]);
  await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, 'kick', 'alpha', 'alpha on kick')`, [cA]);
  await pool.query(`INSERT INTO site.user_marks (matrix_id, reason, source, created_by) VALUES ($1, 'account mark', 'mod', 'mod')`, [A]);

  const require = createRequire(import.meta.url);
  const { createIdentity } = require("../../../stream-api/identity.js") as { createIdentity: (d: { pool: Pool; requestAggregateRefresh: () => void }) => Identity };
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
  identity.registerIdentityRoutes(
    { post: (p: string, ...h: unknown[]) => { routes[p] = h[h.length - 1] as typeof routes[string]; }, get: () => {} },
    { requireInternal: (_q: unknown, _s: unknown, n: () => void) => n(), wrap: (fn: unknown) => fn },
  );
  const revoked: string[] = [];
  const deps: UnlinkDeps = {
    query: (sql, params) => pool.query(sql, params),
    // stream-api's real handler, as the route's streamApiFetch reaches it.
    streamUnlink: async (body) => {
      const res: Res & { status(c: number): unknown; json(b: unknown): unknown } = {
        statusCode: 200, body: null,
        status(c: number) { this.statusCode = c; return this; },
        json(b: unknown) { this.body = b as Res["body"]; return this; },
      };
      await routes["/identity/unlink"]!({ body }, res);
      return res.statusCode;
    },
    revoke: async (platform) => { revoked.push(platform); },
    decrypt: (s) => s,
  };
  const canonicalOf = async (platform: string, id: string) =>
    (await pool.query(`SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2`, [platform, id])).rows[0]?.canonical as string | undefined;

  await t.test("unlink: a fresh identity carrying the account's mark; the site rows go; the sibling stays", async () => {
    assert.deepEqual(await unlinkPlatformAccount(A, "twitch", deps), { ok: true });
    const fresh = await canonicalOf("twitch", TW);
    assert.ok(fresh && fresh !== cA, "the unlinked account still resolves to the person's identity");
    assert.equal(await canonicalOf("kick", KK), cA, "the sibling link moved");
    const mark = (await pool.query(`SELECT source FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [fresh])).rows;
    assert.deepEqual(mark.map((m) => m.source), ["carried"], "the unlink walked away from the account's mark");
    assert.equal((await pool.query(`SELECT 1 FROM site.platform_links WHERE matrix_id = $1 AND platform = 'twitch'`, [A])).rowCount, 0);
    assert.equal((await pool.query(`SELECT 1 FROM site.accounts WHERE matrix_id = $1 AND provider = 'twitch'`, [A])).rowCount, 0);
    assert.deepEqual(revoked, ["twitch"]);
  });

  await t.test("ANOTHER site account links it: its merge takes the platform account, never the first person", async () => {
    const claim = await claimPlatformAccount(pool, {
      matrixId: B, platform: "twitch", platformUserId: TW, accessToken: null, refreshToken: null,
      expiresAt: 0, scope: "", displayName: "tw",
    });
    assert.equal(claim.linked, true);
    // What the link callback then asks stream-api for (/identity/merge { matrixId }).
    await identity.mergeCanonicals(await identity.gatherIdentity(B));
    const twNow = await canonicalOf("twitch", TW);
    const bNow = await canonicalOf("native", B);
    assert.equal(twNow, bNow, "B's identity did not take the platform account");
    assert.notEqual(twNow, cA);
    assert.equal(await canonicalOf("kick", KK), cA, "the first person's other account was merged into B");
    assert.equal((await pool.query(`SELECT 1 FROM stream.users WHERE id = $1`, [cA])).rowCount, 1, "the first person's identity was folded away");
    assert.equal((await pool.query(`SELECT user_id FROM stream.chat_log WHERE message = 'alpha on kick'`)).rows[0]?.user_id, cA,
      "the first person's chat moved to someone else");
    // Hand it back for the next step.
    assert.deepEqual(await unlinkPlatformAccount(B, "twitch", deps), { ok: true });
  });

  await t.test("the SAME account links it again: it is that person's again", async () => {
    const claim = await claimPlatformAccount(pool, {
      matrixId: A, platform: "twitch", platformUserId: TW, accessToken: null, refreshToken: null,
      expiresAt: 0, scope: "", displayName: "tw",
    });
    assert.equal(claim.linked, true);
    const { survivor } = await identity.mergeCanonicals(await identity.gatherIdentity(A));
    assert.ok(survivor);
    assert.equal(await canonicalOf("twitch", TW), survivor);
    assert.equal(await canonicalOf("kick", KK), survivor, "relinking split the person");
    assert.notEqual(await canonicalOf("native", B), survivor, "B rode along");
  });

  await t.test("stream-api does not answer, or fails: nothing is removed and the person is told to retry", async () => {
    for (const streamUnlink of [async () => { throw new Error("connect ECONNREFUSED"); }, async () => 500, async () => 401]) {
      const r = await unlinkPlatformAccount(A, "kick", { ...deps, streamUnlink });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 503);
      assert.equal((await pool.query(`SELECT 1 FROM site.platform_links WHERE matrix_id = $1 AND platform = 'kick'`, [A])).rowCount, 1);
      assert.equal((await pool.query(`SELECT 1 FROM site.accounts WHERE matrix_id = $1 AND provider = 'kick'`, [A])).rowCount, 1);
    }
    assert.ok(!revoked.includes("kick"), "the grant was revoked although the unlink stopped");
  });

  await t.test("a platform account that never chatted (stream-api 404) still unlinks", async () => {
    const NEVER = `${RUN}-yt`;
    await pool.query(`INSERT INTO site.accounts (matrix_id, type, provider, provider_account_id) VALUES ($1, 'oauth', 'youtube', $2)`, [A, NEVER]);
    assert.deepEqual(await unlinkPlatformAccount(A, "youtube", deps), { ok: true });
    assert.equal((await pool.query(`SELECT 1 FROM site.accounts WHERE matrix_id = $1 AND provider = 'youtube'`, [A])).rowCount, 0);
  });
});

test("the route unlinks through the helper, and answers its refusal", () => {
  const raw = readFileSync(join(WEB, "app/api/account-links/route.ts"), "utf8");
  assert.match(raw, /\n\}\n?$/, "END not read");
  const src = stripComments(raw);
  const del = src.slice(src.indexOf("export async function DELETE"));
  assert.match(del, /unlinkPlatformAccount\(matrixId, platform, \{/);
  assert.match(del, /streamApiFetch\("\/identity\/unlink"/);
  assert.doesNotMatch(del, /DELETE FROM site\.(accounts|platform_links)/, "the route deletes rows itself, outside the ordered helper");
  assert.match(del, /status: result\.status/);
});
