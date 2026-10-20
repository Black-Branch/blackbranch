// The banner URL: the card's banner is a Synapse THUMBNAIL, never the full
// download. A phone upload can be 6000×4000 (24 MP, 2 MB); decoding it during
// the account card's entry starves the raster threads for the whole slide, so
// the panel's background fills in tile by tile with no animation.
// `width=800&height=600&method=scale` returns an 800×533 JPEG of 41 KB (0.4 MP).
// `method=crop` at the strip's own aspect returns a 32×32 image — Synapse's
// configured crop sizes are tiny — so scale is mandatory, not a preference. GIF
// banners freeze to their first frame (accepted).
//
// The fallback: Synapse refuses to thumbnail anything over its
// `max_image_pixels` (32 MP by default), so an 8192×4320 = 35 MP banner 404s at
// every thumbnail size while the download stays 200 — a broken image. A banner
// <img> that fails on the THUMBNAIL url swaps once to the download; one that
// fails on the download hides. The handler is typed on the two members it
// touches, so the no-loop rule is executable here against a stub, not a comment.
//
// Run: node --test app/lib/matrixMedia.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { mxcToScaled, mxcToDownload, mxcToHttp, onScaledError } from "./matrixMedia.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail,
    `${rel} did not end as expected — the read is truncated, and every negative assertion below it is vacuous`);
  return stripComments(src);
}

test("mxcToScaled: a scale thumbnail at Synapse's 800×600 size — never crop, never the download", () => {
  const u = mxcToScaled("mxc://site.test/cmgUbYOSUCjbUKbXvhhGsZMy");
  assert.equal(u, "/api/matrix/media/thumbnail/site.test/cmgUbYOSUCjbUKbXvhhGsZMy?width=800&height=600&method=scale");
  assert.doesNotMatch(u!, /method=crop/, "crop returns a 32×32 image for this aspect (measured)");
  assert.doesNotMatch(u!, /\/download\//);
});

test("mxcToScaled: rejects non-mxc and malformed input like its siblings", () => {
  assert.equal(mxcToScaled(null), null);
  assert.equal(mxcToScaled(undefined), null);
  assert.equal(mxcToScaled("https://example.com/x.png"), null);
  assert.equal(mxcToScaled("mxc://only-server"), null);
  // The siblings' contract, pinned alongside so a refactor keeps all three aligned.
  assert.equal(mxcToDownload("mxc://a/b"), "/api/matrix/media/download/a/b");
  assert.equal(mxcToHttp("mxc://a/b", 40), "/api/matrix/media/thumbnail/a/b?width=40&height=40&method=crop");
});

// R2-15: a stored mxc is user-influenced (a federated homeserver's upload answer, a profile's
// avatar_url). With only a `startsWith("mxc://")` check, `mxc://../..\..\..\api\x` built
// `/api/matrix/media/thumbnail/../..\..\..\api\x`, which the browser normalises (backslash = slash)
// to a same-origin `/api/...` GET carrying the viewer's cookies. Every builder now requires the
// strict MXC_RE shape (matrixHtml.ts) — an alphanumeric-bounded server and a plain media id.
test("every mxcTo* refuses a path-escaping or malformed mxc", () => {
  for (const bad of [
    "mxc://../..\\..\\..\\api\\x",
    "mxc://../x",
    "mxc://site.test/../../api/x",
    "mxc://site.test/id/extra",
    "mxc://site.test/id?x=1",
    "mxc://.site.test/id",
    "mxc://site.test/",
  ]) {
    assert.equal(mxcToHttp(bad), null, `mxcToHttp(${bad})`);
    assert.equal(mxcToScaled(bad), null, `mxcToScaled(${bad})`);
    assert.equal(mxcToDownload(bad), null, `mxcToDownload(${bad})`);
  }
  assert.equal(mxcToDownload("mxc://matrix.site.test:8448/AbC_d-e="), "/api/matrix/media/download/matrix.site.test:8448/AbC_d-e=");
});

test("an mxc is checked with MXC_RE before it is STORED (upload answer, profile avatar)", () => {
  const upload = read("app/lib/matrixMediaUpload.ts", /contentUri: content_uri \};\s*}\s*$/);
  assert.match(upload, /if \(typeof content_uri !== "string" \|\| !MXC_RE\.test\(content_uri\)\)/);
  assert.doesNotMatch(upload, /startsWith\("mxc:\/\/"\)/);
  const profile = read("app/lib/matrixProfile.ts", /color === null \? null : \{ \[USERNAME_COLOR\.write\]: color \}\);\s*$/);
  assert.match(profile, /typeof avatarRaw === "string" && MXC_RE\.test\(avatarRaw\) \? avatarRaw : null/);
  assert.doesNotMatch(profile, /startsWith\("mxc:\/\/"\)/);
});

test("onScaledError: thumbnail → download exactly once, then hide", () => {
  const mxc = "mxc://site.test/pRYzqakZAzNEYDYyVeToyZYm";
  const thumb = mxcToScaled(mxc)!;
  const download = mxcToDownload(mxc)!;
  // <img>.src is the RESOLVED absolute url in the browser.
  const img = { src: `https://site.test${thumb}`, style: { display: "" } };
  onScaledError(img, mxc);
  assert.equal(img.src, download);
  assert.equal(img.style.display, "", "the first failure swaps; it must not hide");
  // The download failed too: hide, and never swap back to the thumbnail.
  onScaledError(img, mxc);
  assert.equal(img.src, download);
  assert.equal(img.style.display, "none");
  // A relative src (jsdom, SSR snapshots) decides the same way.
  const rel = { src: thumb, style: { display: "" } };
  onScaledError(rel, mxc);
  assert.equal(rel.src, download);
  // No mxc to fall back to: hide straight away.
  for (const none of [null, undefined]) {
    const i = { src: `https://site.test${thumb}`, style: { display: "" } };
    onScaledError(i, none);
    assert.equal(i.src, `https://site.test${thumb}`);
    assert.equal(i.style.display, "none");
  }
});

test("the inline chat image loads the SCALED thumbnail, never a crop — Synapse served a 96×96 square for the old 400 crop", () => {
  const att = read("app/components/MatrixAttachments.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(att, /const displayUrl = enc \? decUrl : isGif \? mxcToDownload\(mxcUrl\) : mxcToScaled\(mxcUrl\);/);
  assert.doesNotMatch(att, /mxcToHttp\(/, "no crop thumbnail may be requested by the attachment renderer");
  assert.match(att, /onError=\{\(e\) => onScaledError\(e\.currentTarget, mxcUrl\)\}/,
    "an oversize image (>32 MP) must fall back to the download, then hide — same rule as the banner");
  assert.match(att, /const fit = fitMediaBox\(info\?\.w, info\?\.h\);/);
  assert.match(att, /aspectRatio: fit\.aspect/, "the box is reserved from the source aspect before the bitmap lands");
});

test("every banner consumer uses mxcToScaled; the warm decodes the SAME url", () => {
  const parts = read("app/components/profileCardParts.tsx", /<\/span>\s*\);\s*}\s*$/);
  assert.match(parts, /const bannerUrl = mxcToScaled\(bannerMxc\);/);
  assert.doesNotMatch(parts, /mxcToDownload/, "the card must never START on the full-resolution banner");
  assert.match(parts, /onError=\{e => onScaledError\(e\.currentTarget, bannerMxc\)\}/,
    "a thumbnail Synapse refuses (>32 MP) must fall back, not show a broken icon");

  const editor = read("app/components/ProfileEditor.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(editor, /src=\{mxcToScaled\(bannerMxc\) \?\? undefined\}/, "the editor's preview decoded the same 24 MP");
  assert.doesNotMatch(editor, /mxcToDownload/);
  assert.match(editor, /onError=\{e => onScaledError\(e\.currentTarget, bannerMxc\)\}/,
    "the preview must predict the card — same fallback");

  const warm = read("app/lib/profileCardPrefetch.ts", /cache\.invalidate\(\);\s*}\s*$/);
  assert.match(warm, /const banner = mxcToScaled\(d\.me\?\.bannerMxc\);/);
  // The download is warmed ONLY as the thumbnail's rejection handler — the
  // same url the card's <img> falls back to, so an oversize banner is decoded
  // at idle rather than inside the first slide.
  assert.match(warm, /warmImage\(banner\)\.catch\(\(\) => \{\s*const full = mxcToDownload\(d\.me\?\.bannerMxc\);\s*if \(full\) warmImage\(full\)\.catch\(\(\) => \{\}\);/,
    "the download warm must sit in the thumbnail's catch, never run first");
  assert.equal((warm.match(/mxcToDownload\(/g) ?? []).length, 1);
  // `new Image().src` warms BYTES only — the decode still landed inside the
  // first slide (trace: 43 + 35 ms on raster threads at +117 ms). decode()
  // puts the bitmap in the decoded-image cache the card's <img> then shares.
  assert.match(warm, /function warmImage\(src: string\): Promise<void> \{\s*const img = new Image\(\);\s*img\.src = src;\s*return img\.decode\(\);/,
    "the warm must decode, not just fetch");
});
