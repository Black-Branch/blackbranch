// Magic-byte image sniffing shared by the avatar and banner upload routes.
// These bytes are the routes' ONLY defence against a non-image body (the
// client Content-Type is attacker-controlled), so pin the accept/reject line.
//
// Run: node --test app/lib/imageMagic.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasValidImageMagic, sniffImageMime } from "./imageMagic.ts";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("accepts the four allowed formats", () => {
  for (const buf of [png, jpeg, gif, webp]) assert.ok(hasValidImageMagic(buf));
});

test("derives the MIME from the bytes, matching each format", () => {
  assert.equal(sniffImageMime(png), "image/png");
  assert.equal(sniffImageMime(jpeg), "image/jpeg");
  assert.equal(sniffImageMime(gif), "image/gif");
  assert.equal(sniffImageMime(webp), "image/webp");
});

test("rejects RIFF containers that are not WebP (e.g. WAV)", () => {
  // RIFF....WAVE — same 4-byte prefix as WebP; only bytes 8-11 disambiguate.
  const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(hasValidImageMagic(wav), false);
});

test("rejects empty, truncated and non-image bodies", () => {
  assert.equal(hasValidImageMagic(new Uint8Array(0)), false);
  assert.equal(hasValidImageMagic(Uint8Array.from([0x89, 0x50])), false, "truncated PNG prefix");
  assert.equal(hasValidImageMagic(new TextEncoder().encode("<svg onload=alert(1)>")), false, "SVG stays banned");
  assert.equal(hasValidImageMagic(new TextEncoder().encode("MZ......")), false, "executable");
});
