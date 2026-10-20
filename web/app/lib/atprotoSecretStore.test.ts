// Unit tests for the atproto OAuth secret store round-trip. Run with:
//   node --test app/lib/atprotoSecretStore.test.ts
// (Node ≥ 23 strips the TS types natively — no build step or test deps.)
//
// tokenCrypto reads TOKEN_ENC_KEY at call time, so each test sets/clears it to
// exercise both the encrypted and the no-key passthrough paths.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packSecret, unpackSecret } from "./atprotoSecretStore.ts";

const KEY = "0".repeat(64); // 32 bytes hex — valid TOKEN_ENC_KEY
// A representative session blob: the DPoP private key is exactly what must never
// sit in cleartext.
const SESSION = {
  tokenSet: { access_token: "at-secret", refresh_token: "rt-secret", scope: "atproto" },
  dpopJwk: { kty: "EC", crv: "P-256", d: "PRIVATE-KEY-MATERIAL", x: "xx", y: "yy" },
};

test("with a key: packSecret produces ciphertext, unpackSecret round-trips", () => {
  process.env.TOKEN_ENC_KEY = KEY;
  const packed = packSecret(SESSION);
  // Stored value must be a JSON string literal wrapping a v1: ciphertext — the
  // secret material must not appear anywhere in it.
  assert.match(packed, /^"v1:/);
  assert.ok(!packed.includes("PRIVATE-KEY-MATERIAL"), "private key leaked into stored value");
  assert.ok(!packed.includes("rt-secret"), "refresh token leaked into stored value");
  // node-pg returns JSONB parsed: the column round-trips to the inner string.
  const fromDb = JSON.parse(packed);
  assert.deepEqual(unpackSecret(fromDb), SESSION);
});

test("no key: passthrough still round-trips (dev/local without TOKEN_ENC_KEY)", () => {
  delete process.env.TOKEN_ENC_KEY;
  const packed = packSecret(SESSION);
  const fromDb = JSON.parse(packed); // JSONB parse of the stored value
  assert.deepEqual(unpackSecret(fromDb), SESSION);
});

test("legacy plaintext object row reads back unchanged", () => {
  process.env.TOKEN_ENC_KEY = KEY;
  // Rows written before this change are JSONB objects; node-pg returns them parsed.
  assert.deepEqual(unpackSecret(SESSION), SESSION);
});

test("corrupted ciphertext → undefined (re-auth), never throws", () => {
  process.env.TOKEN_ENC_KEY = KEY;
  assert.equal(unpackSecret("v1:bad:bad:bad"), undefined);
});

test("missing row → undefined", () => {
  assert.equal(unpackSecret(null), undefined);
  assert.equal(unpackSecret(undefined), undefined);
});

test("encrypted with one key, unreadable with another → undefined not throw", () => {
  process.env.TOKEN_ENC_KEY = KEY;
  const packed = JSON.parse(packSecret(SESSION));
  process.env.TOKEN_ENC_KEY = "f".repeat(64); // different key
  assert.equal(unpackSecret(packed), undefined);
});
