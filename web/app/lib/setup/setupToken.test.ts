// The setup link's token. Run: node --test app/lib/setup/setupToken.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setupTokenMatches, setupLinkConfigured, setupLinkUsable } from "./setupToken.ts";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef";
const hash = createHash("sha256").update(token).digest("hex");

test("the token matches its sha256 and nothing else", () => {
  assert.equal(setupTokenMatches(token, hash), true);
  assert.equal(setupTokenMatches(token.replace(/.$/, "0"), hash), false);
  assert.equal(setupTokenMatches(hash, hash), false, "the hash itself is not the token");
  for (const bad of [undefined, null, 42, "", "ZZZZ", `${token}\n`, token.toUpperCase()]) assert.equal(setupTokenMatches(bad, hash), false, String(bad));
  // No hash configured (not a bundle install, or a malformed one): nothing matches.
  assert.equal(setupTokenMatches(token, undefined), false);
  assert.equal(setupTokenMatches(token, ""), false);
  assert.equal(setupTokenMatches(token, "abc"), false);
});

test("a link exists only with a well-formed hash", () => {
  assert.equal(setupLinkConfigured({ SETUP_TOKEN_HASH: hash }), true);
  assert.equal(setupLinkConfigured({ SETUP_TOKEN_HASH: "" }), false);
  assert.equal(setupLinkConfigured({}), false);
});

test("single use: the right token works only while no admin exists — after, it is dead", () => {
  assert.equal(setupLinkUsable({ tokenOk: true, adminExists: false }), true);
  assert.equal(setupLinkUsable({ tokenOk: true, adminExists: true }), false, "a used link must not make a second admin");
  assert.equal(setupLinkUsable({ tokenOk: false, adminExists: false }), false);
  assert.equal(setupLinkUsable({ tokenOk: false, adminExists: true }), false);
});
