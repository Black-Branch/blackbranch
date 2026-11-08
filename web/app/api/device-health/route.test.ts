// /api/device-health. Source scan — route modules import pool through the @/lib/db alias, which
// node --test cannot resolve. The behaviour behind these lines is tested directly: limits +
// normalisation in app/lib/deviceHealth/ingest.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { stripComments } from "../../lib/testSource.ts";
import { normalizeReport } from "../../lib/deviceHealth/ingest.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("a late beacon never rolls a row back — the upsert is guarded on seq", () => {
  assert.match(src, /ON CONFLICT \(session_id\) DO UPDATE SET[\s\S]*WHERE site\.device_health\.seq < EXCLUDED\.seq`/);
});

test("matrix_id comes from auth(), never from the body", () => {
  assert.match(src, /\(await auth\(\)\)\?\.user\?\.id/);
  assert.doesNotMatch(src, /body\??\.(matrix|user)/i, "the body must not name the user");
  assert.match(src, /COALESCE\(EXCLUDED\.matrix_id, site\.device_health\.matrix_id\)/);
});

test("limits run before the body is read, the body is read with a streaming cap, and the new-session limit runs after parsing", () => {
  const limited = src.indexOf("gate.limited(ip)");
  const read = src.indexOf("readBodyCapped(req, MAX_BODY_BYTES)");
  const parsed = src.indexOf("normalizeReport(body)");
  const fresh = src.indexOf("gate.newSessionLimited(ip, row.sessionId)");
  const write = src.indexOf("pool.query(");
  for (const [n, i] of Object.entries({ limited, read, parsed, fresh, write })) assert.ok(i !== -1, `${n} missing`);
  assert.ok(limited < read && read < parsed && parsed < fresh && fresh < write);
  assert.doesNotMatch(src, /req\.(text|json|arrayBuffer)\(/, "an unbounded read buffers a chunked body of any size");
});

test("every outcome is a 204 — the beacon never reads the answer, and a 4xx/5xx would be noise", () => {
  assert.doesNotMatch(src, /status:\s*(?!204)\d{3}/);
});

// The route's own upsert, run through the real driver against a replayed schema (v175): a mock pool
// would accept a 32nd parameter with no column behind it.
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");

test("the upsert stores socket_opens apart from socket_reconnects, and a newer beacon updates it", { skip: unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false }, async () => {
  const sql = /pool\.query\(\s*`(INSERT INTO site\.device_health[\s\S]*?)`,\s*\[([\s\S]*?)\]\s*\)/.exec(raw);
  assert.ok(sql, "the route's INSERT was found");
  const params = (row: NonNullable<ReturnType<typeof normalizeReport>>) => [
    row.sessionId, row.seq, "build-test", null, row.route, row.deviceClass, row.narrow, "ua-test",
    row.deviceMemory, row.hwConcurrency, row.effectiveType, row.saveData, row.dpr, row.openMs, row.visibleMs,
    row.loafCount, row.loafBlockingMs, JSON.stringify(row.loafWorst), row.inpMs, JSON.stringify(row.inp), row.cls, row.reqCount, JSON.stringify(row.bytes),
    row.socketReconnects, JSON.stringify(row.player), JSON.stringify(row.decode), JSON.stringify(row.frames), JSON.stringify(row.anim), JSON.stringify(row.settings),
    row.heapStartMb, row.heapPeakMb, row.socketOpens,
  ];
  // The test's own list must be the route's, name for name, so it cannot pass on a different order.
  const routeNames = sql[2]!.split(",").map((x) => x.trim()).filter(Boolean);
  assert.equal(routeNames.length, 32, "32 parameters");
  assert.equal(routeNames[31], "row.socketOpens", "socket_opens is the last parameter");
  const pool = new Pool({ connectionString: DB_URL, max: 1 });
  const sid = crypto.randomUUID();
  const report = (seq: number, sock: Record<string, number>) => normalizeReport({
    v: 1, sid, seq, route: "/", dc: "mobile", openMs: 1000, visMs: 900, sock,
  })!;
  try {
    await pool.query(sql[1]!, params(report(1, { reconnects: 40 })));
    let r = await pool.query("SELECT socket_reconnects, socket_opens FROM site.device_health WHERE session_id = $1", [sid]);
    assert.deepEqual(r.rows[0], { socket_reconnects: 40, socket_opens: null }, "an older page: opens not reported");
    await pool.query(sql[1]!, params(report(2, { reconnects: 94, opens: 3 })));
    r = await pool.query("SELECT socket_reconnects, socket_opens FROM site.device_health WHERE session_id = $1", [sid]);
    assert.deepEqual(r.rows[0], { socket_reconnects: 94, socket_opens: 3 });
  } finally {
    await pool.query("DELETE FROM site.device_health WHERE session_id = $1", [sid]);
    await pool.end();
  }
});

test("END anchor — the file was read to its last function", () => {
  assert.match(src, /async function prune\(\)[\s\S]*\}\s*$/);
});
