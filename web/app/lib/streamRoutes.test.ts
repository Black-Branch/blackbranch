// The Stream tab's routes are the gate: every one is admin-only before it reads anything, none
// writes, and money is asked for only under income=1.
// Run: node --test app/lib/streamRoutes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const ROUTES = [
  "app/api/admin/stream/route.ts",
  "app/api/admin/stream/sessions/route.ts",
  "app/api/admin/stream/sessions/[id]/route.ts",
  "app/api/admin/stream/platforms/route.ts",
];
const read = (rel: string) => {
  const raw = readFileSync(join(process.cwd(), rel), "utf8");
  const src = stripComments(raw);
  const last = raw.trimEnd().split("\n").pop()!;
  assert.ok(src.trimEnd().endsWith(last.trim()), `${rel}: the read lost the end of the file`);
  return src;
};

test("every Stream route checks for an admin first, and returns the refusal before reading anything", () => {
  for (const rel of ROUTES) {
    const src = read(rel);
    const get = src.slice(src.indexOf("export async function GET"));
    assert.ok(get.length > 50, `${rel}: no GET handler`);
    const gate = get.indexOf("const admin = await requireAdminResponse();");
    const refuse = get.indexOf("if (admin instanceof Response) return admin;");
    assert.ok(gate > 0 && refuse > gate, `${rel}: the admin check is missing`);
    for (const reader of ["streamLiveNow(", "loadSessions(", "loadSessionDetail(", "loadLiveDashboard(", "platformRows(", "wantsIncome("]) {
      const at = get.indexOf(reader);
      if (at >= 0) assert.ok(at > refuse, `${rel}: ${reader} runs before the admin check`);
    }
    assert.doesNotMatch(src, /export async function (POST|PUT|PATCH|DELETE)/, `${rel}: the Stream routes only read`);
  }
});

test("money is opt-in: income comes from income=1 and nothing else, and the loaders skip support_events without it", () => {
  const server = read("app/lib/streamTabServer.ts");
  assert.match(server, /return url\.searchParams\.get\("income"\) === "1";/);
  const sql = read("app/lib/streamStatsSql.ts");
  assert.match(sql, /income && g \? loadIncome\(/);
  assert.match(sql, /income \? loadIncome\(q, ids,/);
  assert.match(sql, /income\s*\?\s*q\(`SELECT se\.stream_id/);
  assert.match(sql, /earnedCents: income \? cents : null/);
  const list = read("app/api/admin/stream/sessions/route.ts");
  assert.match(list, /isSessionSort\(raw\) && \(raw !== "earned" \|\| income\)/, "earned order without income leaks the order of the money");
  assert.match(list, /const key = `\$\{sort\}:\$\{income \? 1 : 0\}`;/, "the cache must not hand a no-income caller a money answer");
});

test("the loaders never write and never read the household ledger", () => {
  const sql = read("app/lib/streamStatsSql.ts");
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE)\b/);
  assert.doesNotMatch(sql, /\bfin\./);
  assert.match(sql, /coalesce\(se\.event_type, ''\) = ANY/, "a NULL event type must not drop a real payment from a NOT(...)");
});
