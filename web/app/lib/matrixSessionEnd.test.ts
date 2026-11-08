// The browser's verdict on an ended Matrix session (matrixSessionEnd.ts) and its wiring in
// MatrixClientContext.tsx: only a confirmed revoke wipes, and only that device's store.
// Run: node --test app/lib/matrixSessionEnd.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import { sessionEndFrom, cryptoStorePrefix, userStorePrefix } from "./matrixSessionEnd.ts";

test("signed_out: sign out of the site, keep the store and device id", () => {
  assert.deepEqual(sessionEndFrom(401, { error: "session_expired", reason: "signed_out" }), { kind: "sign-out" });
});

test("revoked with the user and device: wipe exactly that device's store", () => {
  const v = sessionEndFrom(401, { reason: "revoked", matrixId: "@casey:site.test", deviceId: "webABC123" });
  assert.deepEqual(v, { kind: "wipe", prefix: "mx-rust-_casey_site_test-webABC123" });
  // The Rust store's two databases share the prefix; another device's and another user's do not.
  const prefix = v?.kind === "wipe" ? v.prefix ?? "" : "";
  assert.ok("mx-rust-_casey_site_test-webABC123::matrix-sdk-crypto".startsWith(prefix));
  assert.ok(!"mx-rust-_casey_site_test-webOTHER::matrix-sdk-crypto".startsWith(prefix));
  assert.ok(!"mx-rust-_robin_site_test-webABC123::matrix-sdk-crypto".startsWith(prefix));
});

test("revoked for a deleted account (no device named): that user's stores; with no user at all, every Matrix store", () => {
  assert.deepEqual(sessionEndFrom(401, { reason: "revoked", matrixId: "@casey:site.test", deviceId: null }), { kind: "wipe", prefix: userStorePrefix("@casey:site.test") });
  assert.deepEqual(sessionEndFrom(401, { reason: "revoked" }), { kind: "wipe", prefix: null });
});

test("anything else is not an ended session (an outage must never wipe or sign out)", () => {
  for (const [status, body] of [[500, { error: "server_error" }], [503, null], [401, { error: "unauthenticated" }], [401, null], [200, { reason: "revoked" }]] as const) {
    assert.equal(sessionEndFrom(status, body), null, `${status} ${JSON.stringify(body)}`);
  }
});

test("the store prefix is the one the client opens its store under", () => {
  assert.equal(cryptoStorePrefix("@a.b:c-d", "dev_1"), "mx-rust-_a_b_c_d-dev_1");
});

test("MatrixClientContext acts on the verdict: a sign-out keeps stores and the device id; a wipe is scoped", () => {
  const raw = readFileSync(join(import.meta.dirname, "MatrixClientContext.tsx"), "utf8");
  const src = stripComments(raw);
  assert.match(src, /const end = sessionEndFrom\(res\.status, body\);/);
  const signedOut = src.slice(src.indexOf("async function handleSignedOut("), src.indexOf("async function handleRevokedSession("));
  assert.ok(signedOut.length > 50, "handleSignedOut not found");
  assert.doesNotMatch(signedOut, /clearDeviceId|deleteMatrixDatabases|clearAllMatrixDatabases/, "a sign-out must keep the store and device id");
  assert.match(signedOut, /signOut\(/);
  const revoked = src.slice(src.indexOf("async function handleRevokedSession("), src.indexOf("type TokenData"));
  assert.match(revoked, /deleteMatrixDatabases\(\(n\) => n\.startsWith\(prefix\)\)/, "the wipe is scoped to the named prefix");
  assert.match(revoked, /clearDeviceId\(\);/);
  assert.match(src, /cryptoStorePrefix\(userId, deviceId\)/, "the store is opened under the same prefix the wipe names");
  assert.match(src, /export function MatrixClientProvider/, "vacuity: the scan reached the provider");
  assert.ok(src.trimEnd().length > raw.trimEnd().length * 0.5, "vacuity: the file was read");
  assert.match(raw.trimEnd().slice(-400), /\}$/, "vacuity: the END of the file was read");
});
