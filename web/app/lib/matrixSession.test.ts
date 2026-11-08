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

test("the wiring: the getter, the refusal alarm and sign-out go through the executed core", () => {
  // getMatrixSession IS the core's getter (dedup + auth-state outcomes run in matrixSessionCore.test.ts).
  assert.match(src, /export const getMatrixSession: \(\) => Promise<MatrixSession \| null> = createSessionGetter<MatrixSession>\(\{/);
  assert.match(src, /gate: \(matrixId, load\) => policyGatedSession\(matrixId, load\)/);
  assert.doesNotMatch(src, /new Map<string, Promise<MatrixSession>>/, "a second, untested dedup beside the core's");
  // Every refusal reaches the rate watch, whose push goes out under its own constant key.
  assert.match(src, /onRefusal: \(matrixId, side\) => sessionRefusals\.record\(matrixId, side\)/);
  const up = stripComments(readFileSync(join(import.meta.dirname, "matrixSessionUpstream.ts"), "utf8"));
  assert.match(up, /export const sessionRefusals = createSessionAlarms\(\{[\s\S]*?localKey: "web\.matrix-session-refusals",\s*outsideKey: "web\.matrix-session-outside-refusals",/);
  // Sign-out ends the session with the one upstream wiring account deletion also uses.
  assert.match(src, /await endSession\(\{ \.\.\.upstreamDeps\(decToken\), query \}, row\);/);
});

test("federatedRefresh has the default deadline and the OAuth-reply cap", () => {
  const start = src.indexOf("async function federatedRefresh(");
  const end = src.indexOf("\n}\n", start);
  assert.ok(start > 0 && end > start, "federatedRefresh not found");
  const body = src.slice(start, end);
  assert.match(body, /homeserverFetch\(tokenEndpoint, \{/);
  assert.doesNotMatch(body, /timeoutMs|signal:/, "the default deadline must not be replaced here");
  // The answer is read by the core's reader under the OAuth-reply cap (both of its reads use the
  // cap it is given — executed in matrixSessionCore.test.ts).
  const reads = [...body.matchAll(/readRefreshAnswer\(res, (\w+)\)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["OAUTH_REPLY_MAX_BYTES"]);
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)), "the scan did not reach the END of the file");
  assert.match(src, /\}\s*$/);
});
