// R2-15: a link preview's og:image (and a post card's avatar) comes from an arbitrary page. A
// RELATIVE one — `/api/…`, `..\api\…` — rendered as an <img> is a same-origin GET carrying the
// viewer's cookies. Only an absolute http(s) URL is rendered.
// Run: node --test app/lib/previewImage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { previewImageUrl } from "./previewImage.ts";

test("only an absolute http(s) image URL is kept", () => {
  assert.equal(previewImageUrl("https://cdn.site.test/a.png"), "https://cdn.site.test/a.png");
  assert.equal(previewImageUrl("http://cdn.site.test/a.png"), "http://cdn.site.test/a.png");
  for (const bad of [
    "/api/x", "../api/x", "..\\..\\api\\x", "api/x", "//cdn.site.test/a.png",
    "javascript:alert(1)", "data:image/png;base64,AAAA", "", null, undefined, 42,
  ]) {
    assert.equal(previewImageUrl(bad), null, String(bad));
  }
});

test("LinkPreview filters every image it renders through previewImageUrl", () => {
  const raw = readFileSync(join(import.meta.dirname, "..", "components", "LinkPreview.tsx"), "utf8");
  const src = stripComments(raw);
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-12)), "the scan did not reach the END of the file");
  assert.match(src, /image: previewImageUrl\(raw\.image\), avatar: previewImageUrl\(raw\.avatar\)/);
});
