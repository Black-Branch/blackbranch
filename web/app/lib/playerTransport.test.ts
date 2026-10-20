// Tests for the remembered player transport.
//
// Run: node --test app/lib/playerTransport.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransport, TRANSPORT_KEY } from "./playerTransport.ts";

test("both transports round-trip", () => {
  assert.equal(parseTransport("webrtc"), "webrtc");
  assert.equal(parseTransport("hls"), "hls");
});

test("absent is null, so the caller applies its own default", () => {
  assert.equal(parseTransport(null), null);
});

test("junk is null, never coerced into a transport", () => {
  for (const junk of ["", "WEBRTC", "dash", "true", "0", " hls"]) {
    assert.equal(parseTransport(junk), null, `"${junk}" must not parse as a transport`);
  }
});

test("the key is namespaced like its neighbours", () => {
  // player_volume and player_live_source are the siblings; a bare "transport"
  // would collide with anything else on the origin.
  assert.match(TRANSPORT_KEY, /^player_/);
});
