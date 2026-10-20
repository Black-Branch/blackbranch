// /api/device-health. Source scan — route modules import pool through the @/lib/db alias, which
// node --test cannot resolve. The behaviour behind these lines is tested directly: limits +
// normalisation in app/lib/deviceHealth/ingest.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

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

test("END anchor — the file was read to its last function", () => {
  assert.match(src, /async function prune\(\)[\s\S]*\}\s*$/);
});
