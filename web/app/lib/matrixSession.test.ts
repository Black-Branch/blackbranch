// Source scan: the federated token refresh (an outside server's token endpoint, POSTed to on
// nearly every authenticated request once the access token is near expiry) runs through
// homeserverFetch — whose deadline covers the body read (homeserverFetch.test.ts, ssrf.test.ts) —
// without overriding it, and reads the answer under the 16 KiB OAuth-reply cap. matrixSession.ts
// imports @/auth and the pg pool, so it cannot run under node --test; this pins the wiring.
// Run: node --test app/lib/matrixSession.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

const raw = readFileSync(join(import.meta.dirname, "matrixSession.ts"), "utf8");
const src = stripComments(raw);

test("federatedRefresh has the default deadline and the OAuth-reply cap", () => {
  const start = src.indexOf("async function federatedRefresh(");
  const end = src.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "federatedRefresh not found");
  const body = src.slice(start, end);
  assert.match(body, /homeserverFetch\(tokenEndpoint, \{/);
  assert.doesNotMatch(body, /timeoutMs|signal:/, "the default deadline must not be replaced here");
  const reads = [...body.matchAll(/readJsonCapped\(res, (\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["OAUTH_REPLY_MAX_BYTES", "OAUTH_REPLY_MAX_BYTES"]);
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)), "the scan did not reach the END of the file");
  assert.match(src, /\}\s*$/);
});
