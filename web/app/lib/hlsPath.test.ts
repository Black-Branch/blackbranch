// Tests for the HLS path policy.
//
// THE REGRESSION THESE PIN. Compatibility mode in the in-house player never
// worked outside Firefox. The component asked canPlayType BEFORE
// Hls.isSupported(), and Chromium answers "maybe" to
// canPlayType("application/vnd.apple.mpegurl") — measured against production on
// desktop Linux, so this is not an Android-only quirk. Every Chromium viewer
// therefore took the native branch, which our own media-src CSP then refused.
// Neither fact is visible to a source scan of the component, which is why the
// decision lives in a pure module — the whepEscalation.ts precedent.
//
// Run: node --test app/lib/hlsPath.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseHlsImpl, hlsFailureKind, hlsPlaylistUrl } from "./hlsPath.ts";

test('THE REGRESSION: with BOTH available, MSE wins — Chromium says "maybe" and must not be believed', () => {
  assert.equal(chooseHlsImpl({ mseSupported: true, nativeSupported: true }), "mse");
});

test("native is used only where MSE genuinely is not (Safari / iOS)", () => {
  assert.equal(chooseHlsImpl({ mseSupported: false, nativeSupported: true }), "native");
});

test('MSE alone is enough — Firefox answers "" to canPlayType', () => {
  assert.equal(chooseHlsImpl({ mseSupported: true, nativeSupported: false }), "mse");
});

test("neither available reports failure rather than setting an unplayable src", () => {
  assert.equal(chooseHlsImpl({ mseSupported: false, nativeSupported: false }), "none");
});

test("a 404 on the manifest is the stream ENDING, not a broken network", () => {
  // stream.place answers 404 {"message":"StreamNotLive"} once the broadcast is
  // over — verified against their live endpoint.
  assert.equal(hlsFailureKind(404), "ended");
});

test("every other manifest answer is a real failure", () => {
  for (const s of [200, 204, 400, 403, 429, 500, 502, 503]) {
    assert.equal(hlsFailureKind(s), "failed", `status ${s} must not be read as a clean ending`);
  }
});

test("a probe that could not complete is failed, never ended", () => {
  assert.equal(hlsFailureKind(null), "failed",
    "an unknown answer reported as a clean ending would hide a real outage");
});

test("the playlist URL encodes the channel and points at stream.place", () => {
  const u = new URL(hlsPlaylistUrl("site.test"));
  assert.equal(u.origin, "https://stream.place");
  assert.equal(u.searchParams.get("streamer"), "site.test");
});
