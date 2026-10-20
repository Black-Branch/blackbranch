// /api/badges GET + the badge image route. Source scan — these modules import pool through the
// @/lib/db alias, which node --test cannot resolve. The helpers behind them (sniffing, content
// addresses, ETag matching) are tested by RUNNING them in app/lib/badgeImage.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../lib/testSource.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
const img = stripComments(readFileSync(join(import.meta.dirname, "image", "[id]", "[file]", "route.ts"), "utf8"));
const get = src.slice(src.indexOf("export async function GET("), src.indexOf("export async function POST("));

test("GET never inlines a stored image again — every imageUrl goes through publicBadgeImageUrl", () => {
  assert.match(get, /imageUrl: publicBadgeImageUrl\(Number\(d\.id\), d\.image_url\)/);
  assert.doesNotMatch(get, /imageUrl: d\.image_url/, "the raw data URI is back in the polled map");
});

test("GET answers with a strong ETag, private no-cache, and a bodiless 304 on a match", () => {
  assert.match(get, /const etag = etagFor\(body\)/);
  assert.match(get, /"Cache-Control": "private, no-cache"/);
  assert.match(get, /etagMatches\(req\.headers\.get\("if-none-match"\), etag\)\) return new Response\(null, \{ status: 304/);
});

test("the image route is content-addressed: a stale hash is a no-store 404, a hit is immutable", () => {
  assert.match(img, /badgeImageFile\(row\.image_url\) !== file\) return NOT_FOUND\(\)/);
  assert.match(img, /"Cache-Control": "no-store"/);
  assert.match(img, /"Cache-Control": "public, max-age=31536000, immutable"/);
  assert.match(img, /"Content-Type": img\.type/, "the type is the sniffed one, not the data-URI label");
});

test("END anchors — both files were read to their last line", () => {
  assert.match(src, /export async function PATCH\([\s\S]*\}\s*$/);
  assert.match(img, /export async function GET\([\s\S]*\}\s*$/);
});
