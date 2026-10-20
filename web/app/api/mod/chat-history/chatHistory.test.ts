// GET /api/mod/chat-history: mod-gated; every row inspectable (where it was sent, reply, scores
// from the product's own columns, a site message's from its chat_log mirror); one message by id;
// a newer page for Show in context; the native id only through the helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("read to its end (anchor)", () => {
  assert.match(raw, /return Response\.json\(\{ messages, nextCursor, newerCursor \}\);\s*\}\s*$/);
});

test("mod-gated first", () => {
  assert.match(src, /export async function GET\(req: NextRequest\) \{\s*const mod = await requireMod\(\);\s*if \(mod instanceof Response\) return mod;/);
});

test("scores: the platform row's own columns; a site message's from its chat_log mirror by the indexed pair", () => {
  assert.match(src, /cl\.karma, cl\.intelligence/);
  assert.match(src, /WHERE c\.platform IN \$\{NATIVE_SQL\} AND c\.platform_msg_id = m\.id::text/);
  assert.match(src, /scores: \{ karma: num\(r\.karma\), intelligence: num\(r\.intelligence\) \}/);
});

test("where a message was sent, and what it replied to", () => {
  assert.match(src, /COALESCE\(NULLIF\(m\.dest_platforms, ''\), m\.dest_platform\) AS dest_platforms/);
  assert.match(src, /destPlatforms: isNativePlatform\(r\.platform\)/);
  assert.match(src, /replyTo: r\.reply_to_username \?/);
});

test("one message by id needs its platform; a newer page reads ascending and is reversed", () => {
  assert.match(src, /if \(oneId && !platform\) return Response\.json\(\{ error: "id needs platform" \}, \{ status: 400 \}\);/);
  assert.match(src, /const op = before \? "<" : ">";/);
  assert.match(src, /const dir = after \? "ASC" : "DESC";/);
  assert.match(src, /if \(after\) rows\.reverse\(\);/);
});

test("the site's own platform id only through the helper", () => {
  assert.doesNotMatch(src, /'native'|"native"/);
});
