// POST /api/admin/restart: admin + same-origin, only the two fixed verbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");

test("guarded by the admin mutation check before anything else", () => {
  assert.match(src, /export async function POST\(req: Request\) \{\s*const admin = await requireAdminMutation\(req\);\s*if \(admin instanceof Response\) return admin;/);
});

test("asks the host only for the two fixed restart verbs", () => {
  assert.match(src, /const VERB = \{ "stream-api": "restart-stream-api", "stream-ingest": "restart-stream-ingest" \} as const;/);
  assert.match(src, /requestHost\(VERB\[service as keyof typeof VERB\]\)/);
  assert.doesNotMatch(src, /\bexport async function (GET|PUT|DELETE)\b/);
  assert.match(src, /return Response\.json\(\{ requested: true, requestedAt: r\.requestedAt \}\);\s*\}\s*$/, "anchor");
});
