// One platform account belongs to one site account (platformAccountLink.ts).
//
// Upserting site.accounts — moving the account and its tokens to whoever
// completed the OAuth — BEFORE checking ownership, or checking only
// site.platform_links (no row for a platform account that has never chatted),
// lets a second site user silently take the account (and the first user's
// stored tokens) and be told it worked.
//
// The first half drives a mock pool (statement order); the second runs against a
// replayed Postgres, because only a real one can show two transactions racing.
// Runs in CI (web job sets SQL_PARSE_DATABASE_URL); locally, point it at a
// throwaway replayed with migrations/replay-into.sh.
//
// Run: node --test app/lib/platformAccountLink.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { claimPlatformAccount, HELD_BY_OTHER_SQL, type LinkClaim } from "./platformAccountLink.ts";

const claimFor = (matrixId: string, platformUserId: string, token = "enc:access-1"): LinkClaim => ({
  matrixId,
  platform: "twitch",
  platformUserId,
  accessToken: token,
  refreshToken: "enc:refresh-1",
  expiresAt: 1_900_000_000_000,
  scope: "chat:read",
  displayName: "Gadget",
});

// ── statement order (mock pool) ─────────────────────────────────────────────

test("the per-account lock is taken before ownership is read, and a refusal writes nothing", async () => {
  const seen: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string) => {
      seen.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (/FROM site\.accounts[\s\S]*UNION ALL/.test(sql)) return { rows: [{ matrix_id: "@sam:site.test" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { released++; },
  };
  const out = await claimPlatformAccount({ connect: async () => client } as never, claimFor("@casey:site.test", "777"));
  assert.deepEqual(out, { linked: false, owner: "@sam:site.test" });
  const lock = seen.findIndex((s) => s.startsWith("SELECT pg_advisory_xact_lock"));
  const read = seen.findIndex((s, i) => i > 0 && s.startsWith("SELECT matrix_id"));
  assert.ok(lock > 0 && read > lock, `lock must come before the ownership read: ${seen.join(" | ")}`);
  assert.ok(!seen.some((s) => s.startsWith("INSERT")), "a refused claim wrote something");
  assert.equal(seen.at(-1), "ROLLBACK");
  assert.equal(released, 1, "the client was not released");
});

// ── against a real Postgres ─────────────────────────────────────────────────

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `acctlink${process.pid}x${Date.now().toString(36)}`;

test("one platform account, one site account — on the real schema", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 6 });
  let seq = 0;
  const ids = () => `${RUN}${++seq}`;
  const canonicals: string[] = [];
  const clean = async () => {
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.accounts WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE $1`, [`@${RUN}%`]);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE $1`, [`${RUN}%`]);
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE $1`, [`${RUN}%`]);
    if (canonicals.length) await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [canonicals]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  const user = async () => {
    const who = `@${ids()}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    return who;
  };
  /** A platform account that HAS chatted: stream.links maps it to a canonical. */
  const chatted = async () => {
    const pid = ids();
    const canonical = (Date.now().toString(16) + seq.toString(16)).slice(-12).padStart(12, "0");
    canonicals.push(canonical);
    await pool.query(`INSERT INTO stream.users (id) VALUES ($1)`, [canonical]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', $1, $2)`, [pid, canonical]);
    return { pid, canonical };
  };
  const account = async (pid: string) =>
    (await pool.query<{ matrix_id: string; access_token: string }>(
      `SELECT matrix_id, access_token FROM site.accounts WHERE provider = 'twitch' AND provider_account_id = $1`, [pid])).rows;
  const link = async (pid: string) =>
    (await pool.query<{ matrix_id: string }>(
      `SELECT matrix_id FROM site.platform_links WHERE platform = 'twitch' AND platform_id = $1`, [pid])).rows;

  await t.test("(a) linked to A: B's claim is refused, A's account row and tokens untouched", async () => {
    const [a, b] = [await user(), await user()];
    const { pid, canonical } = await chatted();
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(a, pid, "enc:A")), { linked: true, canonicalId: canonical });
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(b, pid, "enc:B")), { linked: false, owner: a });
    assert.deepEqual(await account(pid), [{ matrix_id: a, access_token: "enc:A" }], "B's refused claim changed A's account");
    assert.deepEqual(await link(pid), [{ matrix_id: a }]);
  });

  await t.test("(b) never chatted (no stream.links row): B's claim is still refused", async () => {
    const [a, b] = [await user(), await user()];
    const pid = ids();
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(a, pid, "enc:A")), { linked: true, canonicalId: null });
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(b, pid, "enc:B")), { linked: false, owner: a },
      "with no platform_links row the account moved to B");
    assert.deepEqual(await account(pid), [{ matrix_id: a, access_token: "enc:A" }]);
    assert.deepEqual(await link(pid), []);
  });

  await t.test("(c) the same user re-linking refreshes the tokens", async () => {
    const a = await user();
    const { pid } = await chatted();
    await claimPlatformAccount(pool, claimFor(a, pid, "enc:old"));
    const again = await claimPlatformAccount(pool, claimFor(a, pid, "enc:new"));
    assert.equal(again.linked, true);
    assert.deepEqual(await account(pid), [{ matrix_id: a, access_token: "enc:new" }]);
    assert.deepEqual(await link(pid), [{ matrix_id: a }]);
  });

  await t.test("(e) an id a deleted account left under a ban cannot be claimed; an ordinary one still can", async () => {
    const b = await user();
    const restricted = ids();
    await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason) VALUES ('twitch', $1, $2, 'ban')`,
      [restricted, `@${RUN}-gone:site.test`]);
    const r = await claimPlatformAccount(pool, claimFor(b, restricted, "enc:B"));
    assert.equal(r.linked, false, "a new account took over a restricted platform id");
    assert.deepEqual(await account(restricted), [], "the refused claim wrote an account row");
    const open = ids();
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(b, open, "enc:B")), { linked: true, canonicalId: null });
    // The stream.place callback asks the same query.
    assert.equal((await pool.query(HELD_BY_OTHER_SQL, ["twitch", restricted, b])).rows.length, 1);
    assert.equal((await pool.query(HELD_BY_OTHER_SQL, ["twitch", ids(), b])).rows.length, 0);
  });

  await t.test("(e2) a TIMEOUT's restriction ends: once it has, the id can be claimed again (review round 5, v156)", async () => {
    const b = await user();
    const ended = ids();
    const running = ids();
    await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason, expires_at)
      VALUES ('twitch', $1, $3, 'ban', NOW() - interval '1 minute'), ('twitch', $2, $3, 'ban', NOW() + interval '10 minutes')`,
      [ended, running, `@${RUN}-gone2:site.test`]);
    assert.equal((await claimPlatformAccount(pool, claimFor(b, running, "enc:B"))).linked, false, "a running timeout's id was claimed");
    assert.deepEqual(await claimPlatformAccount(pool, claimFor(b, ended, "enc:B")), { linked: true, canonicalId: null },
      "an ENDED timeout still held the platform id forever");
  });

  for (const chattedBefore of [false, true]) {
    await t.test(`(d) two simultaneous first links by A and B: exactly one wins (${chattedBefore ? "has" : "no"} stream.links row)`, async () => {
      for (let round = 0; round < 5; round++) {
        const [a, b] = [await user(), await user()];
        const pid = chattedBefore ? (await chatted()).pid : ids();
        assert.deepEqual(await account(pid), [], "precondition: no site.accounts row yet");
        assert.deepEqual(await link(pid), [], "precondition: no site.platform_links row yet");
        const [ra, rb] = await Promise.all([
          claimPlatformAccount(pool, claimFor(a, pid, "enc:A")),
          claimPlatformAccount(pool, claimFor(b, pid, "enc:B")),
        ]);
        const winners = [ra, rb].filter((r) => r.linked);
        assert.equal(winners.length, 1, `both or neither won: ${JSON.stringify([ra, rb])}`);
        const winner = ra.linked ? a : b;
        const loser = ra.linked ? rb : ra;
        assert.deepEqual(loser, { linked: false, owner: winner }, "the loser is told who holds it");
        assert.deepEqual(await account(pid), [{ matrix_id: winner, access_token: ra.linked ? "enc:A" : "enc:B" }]);
        assert.deepEqual(await link(pid), chattedBefore ? [{ matrix_id: winner }] : []);
      }
    });
  }
});

test("the link callback writes only through the claim, and refuses before reporting success", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const src = stripComments(readFileSync(new URL("../api/auth/link/[platform]/callback/route.ts", import.meta.url), "utf8"));
  assert.match(src, /\?linked=\$\{platform\}[\s\S]*\);\s*\}\s*$/, "END of the callback not read");
  const claim = src.indexOf("await claimPlatformAccount(pool,");
  const refuse = src.indexOf(`errRedirect(platform, "already_linked")`);
  const success = src.indexOf("?linked=${platform}");
  assert.ok(claim > 0 && refuse > claim && success > refuse, "the claim, its refusal, then success — in that order");
  assert.doesNotMatch(src, /INSERT INTO site\.(accounts|platform_links)/, "the callback writes ownership outside the locked claim");
});

test("the stream.place callback refuses a held or restricted DID before it writes", async () => {
  const { readFileSync } = await import("node:fs");
  const { stripComments } = await import("./testSource.ts");
  const raw = readFileSync(new URL("../api/auth/link/streamplace/callback/route.ts", import.meta.url), "utf8");
  assert.match(raw, /\n\}\n$/, "END of the callback not read");
  const src = stripComments(raw);
  const held = src.indexOf(`await pool.query<{ matrix_id: string }>(HELD_BY_OTHER_SQL, ["streamplace", did, matrixId]);`);
  const refuse = src.indexOf(`if (held.length) return errRedirect("already_linked");`);
  const write = src.indexOf("INSERT INTO site.accounts");
  assert.ok(held > 0 && refuse > held && write > refuse, "the held check, its refusal, then the write — in that order");
  const lib = stripComments(readFileSync(new URL("./platformAccountLink.ts", import.meta.url), "utf8"));
  assert.match(lib, /SELECT matrix_id FROM stream\.erased_restrictions\s+WHERE platform = \$1 AND platform_id = \$2 AND \(expires_at IS NULL OR expires_at > NOW\(\)\)/);
});
