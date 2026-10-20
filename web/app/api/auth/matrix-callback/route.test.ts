// Source scan: the route is plumbing around completeFederatedCallback (federatedSignIn.ts, where
// the decisions are tested with a stub fetch). What only the route can get wrong is ORDER — the
// per-IP limit must run before the cookie is read, and nothing may be written unless the
// decisions passed — and that the state cookie is read by the signed verifier, never JSON.parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("the callback is rate limited per IP before it reads the state cookie", () => {
  assert.match(src, /const isRateLimited = createSlidingWindowLimiter\(60_000, \d+\);/);
  const limit = src.indexOf("isRateLimited(ipKey(req))");
  const cookie = src.indexOf("cookieStore.get(FED_STATE_COOKIE)");
  assert.ok(limit > 0, "no per-IP limit on the callback");
  assert.ok(cookie > limit, "the cookie is read before the limit is checked");
});

test("the state cookie goes through the signed verifier, never JSON.parse", () => {
  assert.doesNotMatch(src, /JSON\.parse/);
  assert.match(src, /completeFederatedCallback\(/);
  assert.match(src, /secret: fedStateSecret\(\)/);
  assert.match(src, /fetch: \(url, init\) => safeFetch\(url, init\)/);
});

test("nothing is written before the decisions pass", () => {
  const decided = src.indexOf("if (!outcome.ok)");
  const firstWrite = src.indexOf("pool.query(");
  assert.ok(decided > 0 && firstWrite > decided, "a write precedes the outcome check");
  assert.match(src, /\}\s*$/); // END anchor: the scan reached the end of the file
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)));
});
