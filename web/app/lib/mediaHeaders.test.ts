// Unit tests for the media-proxy Content-Type hardening. Run with:
//   node --test app/lib/mediaHeaders.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proxiedContentType, imageContentType, mediaDisposition, blobMediaType,
  MEDIA_SAFETY_HEADERS, MEDIA_CSP, MEDIA_PROXY_PREFIX,
} from "./mediaHeaders.ts";

const OCTET = "application/octet-stream";

test("proxiedContentType coerces executable document types to a download", () => {
  assert.equal(proxiedContentType("text/html"), OCTET);
  assert.equal(proxiedContentType("text/html; charset=utf-8"), OCTET);
  assert.equal(proxiedContentType("application/xhtml+xml"), OCTET);
  assert.equal(proxiedContentType("TEXT/HTML"), OCTET);
  assert.equal(proxiedContentType("image/svg+xml"), OCTET);
  assert.equal(proxiedContentType("application/xml"), OCTET);
  assert.equal(proxiedContentType("text/xml"), OCTET);
});

test("an allowlist, not a denylist: every type a browser may render as a document is a download", () => {
  // Each of these passed the old five-entry denylist verbatim.
  for (const t of [
    "application/rss+xml", "application/atom+xml", "application/mathml+xml", "application/xslt+xml",
    "application/vnd.example+xml", "text/xsl", "multipart/x-mixed-replace; boundary=x",
    "application/javascript", "text/javascript", "text/css", "application/json", "text/vtt",
    "application/x-shockwave-flash", "application/octet-stream",
    // A +xml subtype under an allowed top-level type is still an XML document to a browser.
    "video/x-example+xml", "audio/example+xml", "image/example+xml",
  ]) assert.equal(proxiedContentType(t), OCTET, t);
});

test("the WHOLE header is parsed: a comma list or anything but one type + parameters is refused", () => {
  for (const t of [
    "text/plain, text/html", "image/png,text/html", "image/png; a=b, text/html", "image/png text/html",
    "image/png; charset", "image/png;;", "image/png/x", "/png", "image/", "image/png; x=\"unterminated",
    "image/png\u0000", "image/p<ng",
  ]) assert.equal(proxiedContentType(t), OCTET, JSON.stringify(t));
});

test("proxiedContentType passes the allowlisted types through (images, video, audio, plain text)", () => {
  assert.equal(proxiedContentType("image/gif"), "image/gif");
  assert.equal(proxiedContentType("image/gif; charset=binary"), "image/gif");
  assert.equal(proxiedContentType("image/png"), "image/png");
  assert.equal(proxiedContentType("IMAGE/JPEG"), "image/jpeg");
  assert.equal(proxiedContentType("video/mp4"), "video/mp4");
  assert.equal(proxiedContentType("video/webm; codecs=\"vp9, opus\""), "video/webm");
  assert.equal(proxiedContentType("audio/ogg"), "audio/ogg");
  assert.equal(proxiedContentType("audio/mpeg"), "audio/mpeg");
  assert.equal(proxiedContentType("text/plain; charset=utf-8"), "text/plain");
});

test("application/pdf is a download: a browser's PDF viewer runs the document's own script", () => {
  assert.equal(proxiedContentType("application/pdf"), OCTET);
  assert.equal(mediaDisposition(proxiedContentType("application/pdf")), "attachment");
});

test("proxiedContentType falls back only when the upstream type is missing, and only to an allowed type", () => {
  assert.equal(proxiedContentType(null), OCTET);
  assert.equal(proxiedContentType(undefined), OCTET);
  assert.equal(proxiedContentType(""), OCTET);
  assert.equal(proxiedContentType(null, "image/jpeg"), "image/jpeg");
  assert.equal(proxiedContentType("  ", "image/jpeg"), "image/jpeg");
  assert.equal(proxiedContentType(null, "text/html"), OCTET, "a fallback is held to the allowlist too");
  assert.equal(proxiedContentType("text/html", "image/jpeg"), OCTET, "a present but refused type is a download, not the fallback");
});

test("mediaDisposition: a refused type is an attachment; Synapse's attachment header is kept", () => {
  assert.equal(mediaDisposition(OCTET), "attachment");
  assert.equal(mediaDisposition(OCTET, "inline; filename=\"x.html\""), "attachment");
  assert.equal(mediaDisposition(OCTET, "attachment; filename=\"x.html\""), "attachment; filename=\"x.html\"");
  assert.equal(mediaDisposition("image/png"), null);
  assert.equal(mediaDisposition("image/png", "inline; filename=\"a.png\""), null);
  assert.equal(mediaDisposition("image/png", "attachment; filename=\"a.png\""), "attachment; filename=\"a.png\"");
  assert.equal(mediaDisposition("video/mp4", "ATTACHMENT"), "ATTACHMENT");
  assert.equal(mediaDisposition("image/png", "attachmentx"), null, "a look-alike is not attachment");
});

test("blobMediaType: a decrypted attachment's blob takes the same allowlist", () => {
  assert.equal(blobMediaType("image/png"), "image/png");
  assert.equal(blobMediaType("video/mp4"), "video/mp4");
  assert.equal(blobMediaType("text/html"), OCTET);
  assert.equal(blobMediaType("image/svg+xml"), OCTET);
  assert.equal(blobMediaType("text/plain, text/html"), OCTET);
  assert.equal(blobMediaType(undefined), OCTET);
  assert.equal(blobMediaType(42), OCTET);
});

test("imageContentType only reflects known raster image types", () => {
  assert.equal(imageContentType("image/png"), "image/png");
  assert.equal(imageContentType("image/webp"), "image/webp");
  assert.equal(imageContentType("image/JPEG"), "image/jpeg");
  // Non-raster / dangerous → safe raster fallback, never reflected as-is.
  assert.equal(imageContentType("text/html"), "image/png");
  assert.equal(imageContentType("image/svg+xml"), "image/png");
  assert.equal(imageContentType("image/png, text/html"), "image/png");
  assert.equal(imageContentType(null), "image/png");
});

test("safety headers: nosniff + a sandbox that loads nothing but the file itself", () => {
  assert.equal(MEDIA_SAFETY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(MEDIA_SAFETY_HEADERS["Content-Security-Policy"], MEDIA_CSP);
  assert.equal(MEDIA_CSP, "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  assert.doesNotMatch(MEDIA_CSP, /allow-scripts|script-src|unsafe-eval|allow-forms|allow-popups/, "no script may run in a media response, ever");
  assert.equal(MEDIA_PROXY_PREFIX, "/api/matrix/media/");
});
