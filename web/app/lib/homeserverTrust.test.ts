// Pins the homeserverFetch trust decision: only URLs on OUR homeserver's
// origin may skip the SSRF-guarded transport (safeFetch). A false positive
// here means a token-attached server-side fetch to an attacker-controlled
// host goes out unguarded — every case below is a known prefix-match trick.
//
// Run: node --test app/lib/homeserverTrust.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { isLocalHomeserverUrl, sameOrigin } from "./homeserverTrust.ts";
import { matrixBaseUrl } from "./matrixConfig.ts";

const LOCAL = "https://matrix.example.tv";

test("local homeserver URLs are trusted", () => {
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/client/v3/profile/@u:example.tv/avatar_url`, LOCAL), true);
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/client/v1/media/thumbnail/example.tv/abc?width=96`, LOCAL), true);
  // Case and an explicit default port are the same origin to the URL parser — and to fetch.
  assert.equal(isLocalHomeserverUrl("https://MATRIX.example.tv:443/_matrix/x", LOCAL), true);
  // The bare origin IS our server. The old string-prefix check called it untrusted only because
  // it lacked the slash its safety rested on; nothing builds such a URL, and trusting it grants
  // no other host anything.
  assert.equal(isLocalHomeserverUrl(LOCAL, LOCAL), true);
});

test("the default reads the configured homeserver (matrix.baseUrl)", () => {
  assert.equal(matrixBaseUrl(), LOCAL, "premise: testInstallValues's base");
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/x`), true);
  assert.equal(isLocalHomeserverUrl("https://matrix.org/_matrix/x"), false);
});

test("a configured base with a trailing slash still matches (the string-prefix failure)", () => {
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/x`, `${LOCAL}/`), true);
});

test("federated homeservers are not trusted", () => {
  assert.equal(isLocalHomeserverUrl("https://matrix-client.matrix.org/_matrix/client/v3/sync", LOCAL), false);
  assert.equal(isLocalHomeserverUrl("https://matrix.base.nu/_matrix/media/v3/upload", LOCAL), false);
});

test("prefix-match tricks are not trusted", () => {
  // Domain-suffix trick: our base as a subdomain label of an attacker domain.
  assert.equal(isLocalHomeserverUrl("https://matrix.example.tv.evil.com/_matrix/x", LOCAL), false);
  // Userinfo trick: our base as the credentials part of an attacker URL.
  assert.equal(isLocalHomeserverUrl("https://matrix.example.tv@evil.example/_matrix/x", LOCAL), false);
  // Credentials on OUR host: never trusted either.
  assert.equal(isLocalHomeserverUrl("https://u:p@matrix.example.tv/_matrix/x", LOCAL), false);
  // Scheme downgrade.
  assert.equal(isLocalHomeserverUrl("http://matrix.example.tv/_matrix/x", LOCAL), false);
  // Another port.
  assert.equal(isLocalHomeserverUrl("https://matrix.example.tv:8448/_matrix/x", LOCAL), false);
  // Not a URL at all; a relative path; another scheme.
  assert.equal(isLocalHomeserverUrl("matrix.example.tv/_matrix/x", LOCAL), false);
  assert.equal(isLocalHomeserverUrl("/_matrix/x", LOCAL), false);
  assert.equal(isLocalHomeserverUrl("ftp://matrix.example.tv/x", LOCAL), false);
});

test("an unset base trusts nothing", () => {
  assert.equal(isLocalHomeserverUrl(`${LOCAL}/_matrix/x`, ""), false);
});

test("sameOrigin", () => {
  assert.equal(sameOrigin("https://A.example/x", "https://a.example:443/y"), true);
  assert.equal(sameOrigin("https://a.example", "http://a.example"), false);
  assert.equal(sameOrigin("nope", "nope"), false, "two unparseable values are not the same origin");
  assert.equal(sameOrigin("https://u@a.example/", "https://a.example/"), false, "credentials are never the same origin");
});
