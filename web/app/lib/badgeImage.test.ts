// Badge images as URLs + the badge map's ETag.
// Fixtures are real heads of stored badge data URIs, including a WebP that is stored labelled
// image/png.
import test from "node:test";
import assert from "node:assert/strict";
import { parseDataImage, publicBadgeImageUrl, badgeImageFile, etagFor, etagMatches } from "./badgeImage.ts";

const b64 = (bytes: number[] | string) => Buffer.from(typeof bytes === "string" ? bytes : Uint8Array.from(bytes)).toString("base64");
const PNG = "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP_LABELLED_PNG = "data:image/png;base64,UklGRqAVAABXRUJQVlA4TJMVAAAva8AfEDU=";
const GIF = "data:image/gif;base64,R0lGODlhlgCWAOf1AAAAAAAAAQICAwQEBgY=";
const AVIF = "data:image/avif;base64,AAAALGZ0eXBhdmlzAAAAAGF2aWZhdmlzbX==";
const SVG = "data:image/svg+xml;base64," + b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

test("the type comes from the bytes, not the label", () => {
  assert.equal(parseDataImage(PNG)?.ext, "png");
  assert.equal(parseDataImage(WEBP_LABELLED_PNG)?.ext, "webp", "a real badge file is a WebP labelled png");
  assert.equal(parseDataImage(WEBP_LABELLED_PNG)?.type, "image/webp");
  assert.equal(parseDataImage(GIF)?.ext, "gif");
  assert.equal(parseDataImage(AVIF)?.ext, "avif");
  assert.equal(parseDataImage(SVG)?.type, "image/svg+xml");
  assert.equal(parseDataImage("data:image/png;base64," + b64("hello world, not an image")), null);
  assert.equal(parseDataImage("https://x/y.png"), null);
});

test("a data-URI badge becomes an immutable, content-addressed URL; anything else passes through", () => {
  const u = publicBadgeImageUrl(19, GIF);
  assert.match(u, /^\/api\/badges\/image\/19\/[0-9a-f]{16}\.gif$/);
  assert.equal(publicBadgeImageUrl(19, GIF), u, "stable");
  assert.notEqual(badgeImageFile(GIF), badgeImageFile(PNG), "different bytes, different address");
  assert.equal(publicBadgeImageUrl(5, "https://cdn.example/b.png"), "https://cdn.example/b.png");
  assert.equal(publicBadgeImageUrl(5, "/badges/b.png"), "/badges/b.png");
  assert.equal(publicBadgeImageUrl(5, "data:image/png;base64,bm90IGFuIGltYWdl"), "data:image/png;base64,bm90IGFuIGltYWdl",
    "an unrecognisable data URI is left as it was rather than turned into a URL that would 404");
});

test("ETag: strong, stable, and matched weakly (Cloudflare weakens it when compressing)", () => {
  const e = etagFor('{"a":1}');
  assert.match(e, /^"[\w-]{27}"$/);
  assert.equal(etagFor('{"a":1}'), e);
  assert.notEqual(etagFor('{"a":2}'), e);
  assert.equal(etagMatches(e, e), true);
  assert.equal(etagMatches(`W/${e}`, e), true);
  assert.equal(etagMatches(`"other", W/${e}`, e), true);
  assert.equal(etagMatches("*", e), true);
  assert.equal(etagMatches('"other"', e), false);
  assert.equal(etagMatches(null, e), false);
  assert.equal(etagMatches("", e), false);
});
