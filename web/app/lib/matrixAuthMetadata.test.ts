// Sign-in endpoints come from the homeserver's auth_metadata, validated, cached — and a failure
// is NEVER a revocation (matrixAuthMetadata.ts says why that is the load-bearing rule).
//
// Run: node --test app/lib/matrixAuthMetadata.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAuthMetadata, createAuthMetadataCache } from "./matrixAuthMetadata.ts";

/** The module's error carries a fixed `code` (the class itself is internal). */
const isMetaErr = (e: unknown): e is Error & { code: string } =>
  e instanceof Error && /^auth metadata /.test(e.message) && typeof (e as { code?: unknown }).code === "string";
import { stripComments } from "./testSource.ts";

const ISSUER = "https://matrix.example.tv/auth/";
// The shape MAS returns (measured against a live homeserver, values neutralised).
const DOC = {
  issuer: ISSUER,
  account_management_uri: "https://matrix.example.tv/auth/account/",
  authorization_endpoint: "https://matrix.example.tv/auth/authorize",
  token_endpoint: "https://matrix.example.tv/auth/oauth2/token",
  revocation_endpoint: "https://matrix.example.tv/auth/oauth2/revoke",
  registration_endpoint: "https://matrix.example.tv/auth/oauth2/registration",
  grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
  code_challenge_methods_supported: ["plain", "S256"],
};

/** DOC minus some fields. */
const without = (...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(DOC).filter(([k]) => !keys.includes(k)));

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    assert.ok(isMetaErr(e), `threw ${String(e)}`);
    return e.code;
  }
  return "no error";
};

test("a real document parses to the endpoints", () => {
  assert.deepEqual(parseAuthMetadata(DOC, ISSUER), {
    issuer: ISSUER,
    authorizationEndpoint: DOC.authorization_endpoint,
    tokenEndpoint: DOC.token_endpoint,
    revocationEndpoint: DOC.revocation_endpoint,
    accountManagementUri: DOC.account_management_uri,
    registrationEndpoint: DOC.registration_endpoint,
  });
});

test("the issuer must match BYTE FOR BYTE (RFC 8414 §3.3)", () => {
  assert.equal(code(() => parseAuthMetadata(DOC, "https://matrix.example.tv/auth")), "issuer_mismatch", "a missing slash is another issuer");
  assert.equal(code(() => parseAuthMetadata({ ...DOC, issuer: "https://evil.example/" }, ISSUER)), "issuer_mismatch");
  // An outside server (federated sign-in) names its own issuer: no pin, same endpoint rules.
  assert.equal(parseAuthMetadata({ ...DOC }, null).issuer, ISSUER);
});

test("required endpoints, and every endpoint on the issuer's origin", () => {
  assert.equal(code(() => parseAuthMetadata(without("authorization_endpoint"), ISSUER)), "missing_endpoint");
  assert.equal(code(() => parseAuthMetadata(without("token_endpoint"), ISSUER)), "missing_endpoint");
  for (const field of ["authorization_endpoint", "token_endpoint", "revocation_endpoint", "account_management_uri"]) {
    assert.equal(code(() => parseAuthMetadata({ ...DOC, [field]: "https://elsewhere.example/x" }, ISSUER)),
      "endpoint_off_issuer_origin", `${field} on another origin must be refused — it would receive the secret / the browser`);
  }
  assert.equal(code(() => parseAuthMetadata({ ...DOC, token_endpoint: "http://matrix.example.tv/auth/oauth2/token" }, ISSUER)),
    "bad_endpoint", "an https issuer never hands out http");
  assert.equal(code(() => parseAuthMetadata({ ...DOC, token_endpoint: "https://u:p@matrix.example.tv/t" }, ISSUER)), "bad_endpoint");
  assert.equal(code(() => parseAuthMetadata({ ...DOC, token_endpoint: "not a url" }, ISSUER)), "bad_endpoint");
  // Optional ones may be absent.
  const md = parseAuthMetadata(without("revocation_endpoint", "account_management_uri", "registration_endpoint"), ISSUER);
  assert.deepEqual([md.revocationEndpoint, md.accountManagementUri, md.registrationEndpoint], [null, null, null]);
});

test("capabilities this site uses must be listed when the server lists any", () => {
  assert.equal(code(() => parseAuthMetadata({ ...DOC, code_challenge_methods_supported: ["plain"] }, ISSUER)), "no_s256");
  assert.equal(code(() => parseAuthMetadata({ ...DOC, grant_types_supported: ["authorization_code"] }, ISSUER)), "grant_unsupported");
  assert.equal(parseAuthMetadata(without("code_challenge_methods_supported", "grant_types_supported"), ISSUER).issuer, ISSUER, "absent = not stated, accepted");
  assert.equal(code(() => parseAuthMetadata(null, ISSUER)), "not_json");
  assert.equal(code(() => parseAuthMetadata("x", ISSUER)), "not_json");
});

// ── the cache ──────────────────────────────────────────────────────────────────────────────
function harness(responses: Array<() => Promise<Response>>) {
  let t = 1_000_000;
  const calls: string[] = [];
  const notified: string[] = [];
  const errors: string[] = [];
  const c = createAuthMetadataCache({
    baseUrl: () => "https://matrix.example.tv",
    issuer: () => ISSUER,
    fetch: async (url) => {
      calls.push(url);
      const next = responses.shift();
      assert.ok(next, "more fetches than the test scripted");
      return next();
    },
    now: () => t,
    log: { error: (m: string) => errors.push(m), warn() {}, log() {} },
    notify: (c) => notified.push(c),
  });
  return { c, calls, notified, errors, advance: (ms: number) => { t += ms; } };
}
const ok = () => Promise.resolve(Response.json(DOC));
const down = () => Promise.reject(new TypeError("fetch failed"));
const H = 60 * 60 * 1000;

test("fetches <base>/_matrix/client/v1/auth_metadata once, then serves the cache for an hour", async () => {
  const h = harness([ok, ok]);
  assert.equal((await h.c.get()).tokenEndpoint, DOC.token_endpoint);
  assert.deepEqual(h.calls, ["https://matrix.example.tv/_matrix/client/v1/auth_metadata"]);
  h.advance(H - 1);
  await h.c.get();
  assert.equal(h.calls.length, 1);
  h.advance(2);
  await h.c.get();
  assert.equal(h.calls.length, 2, "refetched after the hour");
});

test("concurrent first callers share ONE fetch", async () => {
  const h = harness([ok]);
  await Promise.all([h.c.get(), h.c.get(), h.c.get()]);
  assert.equal(h.calls.length, 1);
});

test("no copy + unreachable: a TRANSIENT metadata error, logged + notified, then a 10 s back-off", async () => {
  const h = harness([down, ok]);
  await assert.rejects(h.c.get(), (e: unknown) => isMetaErr(e) && e.code === "unreachable");
  assert.deepEqual(h.notified, ["unreachable"]);
  assert.match(h.errors[0]!, /\[matrix-auth\] auth_metadata FAILED \(unreachable\) — sign-in UNAVAILABLE/);
  h.advance(5_000);
  await assert.rejects(h.c.get(), isMetaErr);
  assert.equal(h.calls.length, 1, "inside the back-off: no second fetch");
  h.advance(5_001);
  assert.equal((await h.c.get()).issuer, ISSUER, "after the back-off it tries again and recovers");
  assert.equal(h.calls.length, 2);
});

test("an HTTP error or an invalid document is a failure with its own code", async () => {
  const h = harness([() => Promise.resolve(new Response("no", { status: 404 }))]);
  await assert.rejects(h.c.get(), (e: unknown) => isMetaErr(e) && e.code === "http_error");
  const h2 = harness([() => Promise.resolve(Response.json({ ...DOC, issuer: "https://other/" }))]);
  await assert.rejects(h2.c.get(), (e: unknown) => isMetaErr(e) && e.code === "issuer_mismatch");
  assert.deepEqual(h2.notified, ["issuer_mismatch"]);
});

test("a stale copy keeps serving through a failed refresh — for up to a day, not forever", async () => {
  const h = harness([ok, down, down]);
  await h.c.get();
  h.advance(H + 1);
  assert.equal((await h.c.get()).tokenEndpoint, DOC.token_endpoint, "refresh failed: the last good copy serves");
  assert.match(h.errors[0]!, /serving the last good copy/);
  h.advance(5_000);
  assert.equal((await h.c.get()).tokenEndpoint, DOC.token_endpoint, "inside the back-off: still the stale copy");
  h.advance(24 * H);
  await assert.rejects(h.c.get(), isMetaErr, "past a day the stale copy is no longer trusted");
});

test("peek never throws", async () => {
  const h = harness([down]);
  assert.equal(await h.c.peek(), null);
});

test("not configured: refuses without fetching", async () => {
  const c = createAuthMetadataCache({
    baseUrl: () => "", issuer: () => ISSUER,
    fetch: () => { throw new Error("must not fetch"); },
    now: () => 0, log: { error() {}, warn() {}, log() {} }, notify() {},
  });
  await assert.rejects(c.get(), (e: unknown) => isMetaErr(e) && e.code === "not_configured");
});

// ── the callers: no string-built sign-in paths, and a discovery failure is never a revoke ──
const WEB = join(process.cwd());
const read = (p: string) => readFileSync(join(WEB, p), "utf8");

test("no auth file string-builds an OAuth path or reads MAS_* env directly", () => {
  const files = [
    "app/api/auth/mas-initiate/route.ts",
    "app/api/auth/mas-callback/route.ts",
    "app/lib/matrixSession.ts",
    "app/lib/matrixOAuthClient.ts",
  ];
  for (const f of files) {
    const raw = read(f);
    assert.ok(raw.trimEnd().length > 500, `${f} read short`);
    const src = stripComments(raw);
    // Positive anchor first: each file still does its job through the shared client/discovery.
    assert.match(src, /authMetadata|oauthTokenRequest|oauthRevoke/, `${f} no longer uses discovery — the scan is reading the wrong file`);
    assert.doesNotMatch(src, /oauth2\/(token|revoke)|[`"']\s*authorize|\}account`/, `${f}: an issuer-relative path is string-built`);
    assert.doesNotMatch(src, /process\.env\.MAS_/, `${f}: MAS_* read directly — use matrix.oauth.* (instance schema)`);
  }
});

test("the local refresh treats a discovery failure as TRANSIENT (never RevokedSessionError)", () => {
  const src = stripComments(read("app/lib/matrixSession.ts"));
  const start = src.indexOf("async function localRefresh(");
  assert.ok(start > 0, "localRefresh is gone — the scan is blind");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  // The ONLY revoke verdict is the token endpoint's own answer, read after a response exists.
  const revokeAt = body.indexOf("throw new RevokedSessionError()");
  assert.ok(revokeAt > 0, "the invalid_grant → revoked mapping is gone");
  assert.ok(body.indexOf("invalid_grant") < revokeAt && body.indexOf("invalid_grant") > body.indexOf("if (!res.ok)"),
    "RevokedSessionError must be thrown only from the token endpoint's invalid_grant answer");
  assert.doesNotMatch(body, /\btry\s*\{/, "a try/catch here could map a discovery failure onto a revoke");
});
