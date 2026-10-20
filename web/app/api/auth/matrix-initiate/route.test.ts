// Source scan: matrix-initiate re-checks the endpoints the browser sends (federatedSignIn.ts
// initiateEndpointsProblem — tested there), SIGNS the state cookie, and logs at most 2 KiB of an
// outside server's error body. A `javascript:` authorize endpoint used to be turned into the URL
// the sign-in page navigates to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("the endpoints are checked before the registration request and before the authorize URL is built", () => {
  const check = src.indexOf("initiateEndpointsProblem(");
  const register = src.indexOf("safeFetch(registrationEndpoint");
  const build = src.indexOf("new URL(authorizationEndpoint)");
  assert.ok(check > 0, "the endpoints are not checked");
  assert.ok(register > check && build > check, "a request or the authorize URL comes before the check");
});

test("the state cookie is signed, never plain JSON", () => {
  assert.match(src, /cookieStore\.set\(FED_STATE_COOKIE, signFedState\(/);
  assert.doesNotMatch(src, /JSON\.stringify\(\{ state,/);
});

test("an error body is logged at most ERROR_LOG_MAX_BYTES, and the reply is read capped", () => {
  assert.match(src, /readBodyPrefix\(reg, ERROR_LOG_MAX_BYTES\)/);
  assert.match(src, /readJsonCapped\(reg, OAUTH_REPLY_MAX_BYTES\)/);
  assert.match(src, /\}\s*$/); // END anchor
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)));
});
