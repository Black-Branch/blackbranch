// A refused refresh (400/401) marks the link expired once and stops asking the platform;
// a transient failure marks nothing; a later success or a relink clears the mark.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";

const { createPlatformTokens } = await import("./platformTokens.ts");

type Row = { id: string; provider: string; access_token: string | null; refresh_token: string | null; expires_at: number; refresh_failed_at: Date | null };

function harness(answers: number[]) {
  const row: Row = { id: "acc1", provider: "kick", access_token: "old", refresh_token: "r1", expires_at: 0, refresh_failed_at: null };
  const sql: string[] = [];
  const posts: string[] = [];
  const logs: string[] = [];
  const get = createPlatformTokens({
    query: async <R,>(q: string, params: unknown[]) => {
      sql.push(q.replace(/\s+/g, " ").trim());
      if (/^SELECT/.test(q.trim())) return { rows: [{ ...row }] as unknown as R[] };
      if (/refresh_failed_at = now\(\)/.test(q)) { if (row.refresh_failed_at === null) row.refresh_failed_at = new Date(); return { rows: [] }; }
      if (/SET access_token/.test(q)) { row.access_token = String(params[0]); row.expires_at = Number(params[2]); row.refresh_failed_at = null; return { rows: [] }; }
      return { rows: [] };
    },
    fetch: async (url) => {
      posts.push(url);
      const status = answers.shift() ?? 500;
      return { ok: status === 200, status, json: async () => ({ access_token: "new", expires_in: 3600 }) };
    },
    config: () => ({ clientId: "id", clientSecret: "secret", tokenUrl: "https://id.kick.example/oauth/token" }),
    enc: (v) => v,
    dec: (v) => v,
    now: () => 1_000_000,
    log: { error: (...a: unknown[]) => logs.push(a.join(" ")), warn: (...a: unknown[]) => logs.push(a.join(" ")) },
  });
  return { get, row, sql, posts, logs };
}

test("a 401 refresh marks the link expired and returns null; the next call never asks the platform again", async () => {
  const h = harness([401]);
  assert.equal(await h.get("@casey:site.test", "kick"), null);
  assert.ok(h.row.refresh_failed_at, "marked");
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /refused the refresh \(401\)/);
  // Retry: the same send again, and again.
  assert.equal(await h.get("@casey:site.test", "kick"), null);
  assert.equal(await h.get("@casey:site.test", "kick"), null);
  assert.equal(h.posts.length, 1, "the platform was asked once, not on every send");
  assert.equal(h.logs.length, 1, "one log line, not one per send");
});

test("a 400 (Twitch's invalid_grant) is the same refusal", async () => {
  const h = harness([400]);
  assert.equal(await h.get("@casey:site.test", "twitch"), null);
  assert.ok(h.row.refresh_failed_at);
});

test("a transient failure (5xx) marks nothing and the next call tries again", async () => {
  const h = harness([503, 200]);
  assert.equal(await h.get("@casey:site.test", "kick"), null);
  assert.equal(h.row.refresh_failed_at, null, "not marked");
  assert.equal(await h.get("@casey:site.test", "kick"), "new", "retry recovers");
  assert.equal(h.posts.length, 2);
});

test("a successful refresh clears an old mark in the same write", async () => {
  const h = harness([200]);
  assert.equal(await h.get("@casey:site.test", "kick"), "new");
  assert.ok(h.sql.some((q) => /SET access_token = \$1, refresh_token = \$2, expires_at = \$3, refresh_failed_at = NULL/.test(q)));
});

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("linking again clears the mark; the panel route reports it; the panel offers Reconnect", () => {
  assert.match(read("./platformAccountLink.ts"), /refresh_failed_at\s+= NULL/);
  const route = read("../api/account-links/route.ts");
  assert.match(route, /SELECT provider, provider_account_id, account_display_name, linked_at, scope, refresh_failed_at/);
  assert.match(route, /expired: r\.refresh_failed_at !== null/);
  assert.match(read("../components/LinkedAccountsInline.tsx"), /expired: a\.expired === true/);
  const panel = read("../components/AccountLinkPanel.tsx");
  assert.match(panel, /`Reconnect \$\{label\}`/);
  assert.doesNotMatch(panel, /No platforms configured yet\./, "W19: the empty state says why");
});

test("the column comes from migration v160 and the baseline carries it", () => {
  const mig = readFileSync(new URL("../../../migrations/migrate-v160.sql", import.meta.url), "utf8");
  assert.match(mig, /ALTER TABLE site\.accounts ADD COLUMN IF NOT EXISTS refresh_failed_at TIMESTAMPTZ;/);
  assert.match(mig, /VALUES \(160, /);
  const base = readFileSync(new URL("../../../migrations/baseline/schema.sql", import.meta.url), "utf8");
  assert.match(base, /refresh_failed_at timestamp with time zone/);
  // Vacuity anchor at the END of the migration: COMMIT is its last statement.
  assert.match(mig.trimEnd(), /COMMIT;$/);
});
