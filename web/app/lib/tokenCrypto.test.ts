import { test } from "node:test";
import assert from "node:assert/strict";
import { encToken, decToken } from "./tokenCrypto.ts";

// Platform OAuth tokens and Matrix refresh tokens are stored through encToken.
// With no key, handing the plaintext straight back, in production too, would
// mean a deployment that forgot TOKEN_ENC_KEY (or mistyped it) stores every token
// readable, with one console line nobody is watching. stream-api refuses to
// start without its secret; this is the same rule for the same class of mistake.

const KEY = "ab".repeat(32);
const env = process.env as Record<string, string | undefined>;
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = env[k]; if (vars[k] === undefined) delete env[k]; else env[k] = vars[k]; }
  try { fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; } }
}

test("with a key, a token round-trips and is not stored readable", () => {
  withEnv({ TOKEN_ENC_KEY: KEY, NODE_ENV: "production" }, () => {
    const stored = encToken("secret-token")!;
    assert.match(stored, /^v1:/);
    assert.ok(!stored.includes("secret-token"));
    assert.equal(decToken(stored), "secret-token");
  });
});

test("in production, no key means REFUSE — never store the plaintext", () => {
  withEnv({ TOKEN_ENC_KEY: undefined, NODE_ENV: "production" }, () => {
    assert.throws(() => encToken("secret-token"), /TOKEN_ENC_KEY/);
  });
});

test("in production, a malformed key is the same refusal", () => {
  withEnv({ TOKEN_ENC_KEY: "not-hex", NODE_ENV: "production" }, () => {
    assert.throws(() => encToken("secret-token"), /TOKEN_ENC_KEY/);
  });
});

test("outside production a missing key still passes through (local dev has no key)", () => {
  withEnv({ TOKEN_ENC_KEY: undefined, NODE_ENV: "development" }, () => {
    assert.equal(encToken("secret-token"), "secret-token");
  });
});

test("null stays null and never throws, key or not", () => {
  withEnv({ TOKEN_ENC_KEY: undefined, NODE_ENV: "production" }, () => {
    assert.equal(encToken(null), null);
    assert.equal(encToken(undefined), null);
  });
});
