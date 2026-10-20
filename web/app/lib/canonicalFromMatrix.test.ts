// The ONE preferred canonical behind a site account (canonicalFromMatrix.ts) — what every display
// read of "this account's identity" uses — against a real Postgres with a SPLIT identity, and a
// ratchet on files that read both link tables themselves.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/canonicalFromMatrix.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Pool } from "pg";
import { canonicalFromMatrixSql, preferredCanonical } from "./canonicalFromMatrix.ts";
import { getUserContext } from "./userContext.ts";
import { stripComments } from "./testSource.ts";

const WEB = process.cwd();

// ── against a real Postgres ─────────────────────────────────────────────────

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
// Never production: only a throwaway on this machine (a shell may carry DATABASE_URL = prod).
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `cfm${process.pid}x${Date.now().toString(36)}`;
// 12-hex canonicals unique to this run.
const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");

test("a split identity: every reader of the ONE preferred canonical agrees, and it is stream-api's", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const me = `@${RUN}:site.test`;
  const solo = `@${RUN}-solo:site.test`;
  const [native, twitch, youtube, a, b] = [hex(1), hex(2), hex(3), hex(4), hex(5)];
  const ids = [native, twitch, youtube, a, b];
  const clean = async () => {
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id IN ($1, $2)`, [me, solo]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id IN ($1, $2)`, [me, solo]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2)`, [me, solo]);
  for (const id of ids) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, $1)`, [id]);
  await pool.query(`UPDATE stream.users SET pronouns = 'she/her' WHERE id = $1`, [native]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2), ('twitch', $3, $4), ('youtube', $5, $6)`,
    [me, native, `${RUN}-tw`, twitch, `${RUN}-yt`, youtube]);
  // Two platform links on two OTHER canonicals: the split the tie-break exists for.
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($1, 'youtube', $4, $5)`,
    [me, `${RUN}-tw`, twitch, `${RUN}-yt`, youtube]);

  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  // stream-api's own resolver (identity.js resolveCanonical) is the reference order.
  const require = createRequire(import.meta.url);
  const { createIdentity } = require("../../../stream-api/identity.js") as { createIdentity: (d: { pool: Pool }) => {
    resolveCanonical: (c: string | null, m: string) => Promise<string | null>; gatherIdentity: (m: string) => Promise<string[]> } };
  const identity = createIdentity({ pool });

  const helper = await preferredCanonical(me, q);
  const ctx = await getUserContext(me, pool);
  const pronouns = (await pool.query(`SELECT u.pronouns FROM stream.users u WHERE u.id = ${canonicalFromMatrixSql("$1")}`, [me])).rows[0]?.pronouns;
  const streamApi = await identity.resolveCanonical(null, me);
  assert.equal(helper, native, "the account's own (native) canonical is preferred");
  assert.equal(ctx.canonicalId, native, "userContext (My stats, popout) disagrees");
  assert.equal(pronouns, "she/her", "the pronoun read disagrees");
  assert.equal(streamApi, native, "stream-api resolves a different canonical");
  // EVERY linked identity is a different question, with a different answer.
  assert.deepEqual((await identity.gatherIdentity(me)).sort(), [native, twitch, youtube].sort());

  // No native row: the lowest platform-linked canonical, the same on every call.
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($1, 'youtube', $4, $5)`,
    [solo, `${RUN}-tw2`, b, `${RUN}-yt2`, a]);
  const want = [a, b].sort()[0];
  for (let i = 0; i < 5; i++) {
    assert.equal(await preferredCanonical(solo, q), want);
    assert.equal((await getUserContext(solo, pool)).canonicalId, want);
  }
});

// ── the readers, and a ratchet on the rest ──────────────────────────────────

test("the three display readers go through the one helper", () => {
  const read = (p: string) => {
    const raw = readFileSync(join(WEB, p), "utf8");
    assert.match(raw, /\n\}\n?$|\);\n?$/, `${p}: END not read`);
    return stripComments(raw);
  };
  assert.match(read("app/api/me/pronouns/route.ts"), /WHERE u\.id = \$\{canonicalFromMatrixSql\("\$1"\)\}/);
  assert.match(read("app/popout/page.tsx"), /preferredCanonical\(matrixId, /);
  assert.match(read("app/lib/userContext.ts"), /\$\{canonicalFromMatrixSql\("\$1"\)\} AS canonical/);
});

// A file that reads BOTH link tables itself is a place a second tie-break can grow. The ones that
// do today are listed (most answer the EVERY-linked question, which is theirs to ask); the list may
// only shrink — a new file fails, and a file that stops fails until it is removed here.
const BOTH_TABLES = [
  "app/api/auth/link/streamplace/callback/route.ts",
  "app/api/mod/identity/resolve/route.ts",
  "app/api/mod/purge/route.ts",
  "app/lib/boards.ts",
  "app/lib/canonicalIdentity.ts",
  "app/lib/identitySpan.ts",
  "app/lib/platformAccountLink.ts",
  "app/lib/platformMod/shared.ts",
  "lib/socialCredit.ts",
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(WEB, dir))) {
    const rel = `${dir}/${f}`;
    if (f === "node_modules" || f.startsWith(".")) continue;
    if (statSync(join(WEB, rel)).isDirectory()) { out.push(...sources(rel)); continue; }
    if (/\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\./.test(f) && !/\.generated\./.test(f)) out.push(rel);
  }
  return out;
}

test("no NEW file reads both link tables outside the helper (ratchet: the list only shrinks)", () => {
  const files = [...sources("app"), ...sources("lib")];
  assert.ok(files.length > 300, `vacuity: only ${files.length} source files found`);
  const both = files
    .filter((f) => f !== "app/lib/canonicalFromMatrix.ts")
    .filter((f) => { const s = stripComments(readFileSync(join(WEB, f), "utf8")); return s.includes("stream.links") && s.includes("site.platform_links"); })
    .sort();
  assert.deepEqual(both, [...BOTH_TABLES].sort());
  // Vacuity anchor on the END of the helper: the scan reads the file the exemption names.
  const helper = readFileSync(join(WEB, "app/lib/canonicalFromMatrix.ts"), "utf8");
  assert.match(helper, /return rows\[0\]\?\.canonical \?\? null;\n {2}\} catch \{\n {4}return null;\n {2}\}\n\}\n$/);
});
