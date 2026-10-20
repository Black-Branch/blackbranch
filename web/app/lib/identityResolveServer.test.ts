import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createIdentityResolver, RESOLVE_TIMEOUT_MS } from "./identityResolveServer.ts";
import { stripComments } from "./testSource.ts";

type Q = { sql: string; params: unknown[] };
function fakePool(displayName: string | null, opts: { throws?: boolean } = {}) {
  const seen: Q[] = [];
  return {
    seen,
    pool: {
      query: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql, params });
        if (opts.throws) throw new Error("connection reset");
        return { rows: [{ display_name: displayName }], rowCount: 1 };
      },
    },
  };
}
function fakeFetch(status = 200, opts: { throws?: boolean } = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = async (p: string, init?: RequestInit) => {
    calls.push({ path: p, body: JSON.parse(String(init?.body ?? "null")) });
    if (opts.throws) throw new Error("ECONNREFUSED");
    return { ok: status < 400, status, json: async () => ({ ok: true, canonicalId: "abc" }) } as Response;
  };
  return { calls, fetch };
}
const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

test("sends the STORED display name for the site's own platform", async () => {
  const { pool, seen } = fakePool("Kay");
  const f = fakeFetch();
  await createIdentityResolver({ pool, fetch: f.fetch }).resolveSiteIdentity("@k:site.test");
  assert.match(seen[0]!.sql, /SELECT display_name FROM site\.users WHERE matrix_id = \$1/);
  assert.deepEqual(f.calls, [{ path: "/identity/resolve", body: { platform: "native", userId: "@k:site.test", username: "Kay" } }]);
});

test("falls back to the localpart only when no name is stored", async () => {
  const f = fakeFetch();
  await createIdentityResolver({ pool: fakePool(null).pool, fetch: f.fetch }).resolveSiteIdentity("@k:site.test");
  assert.equal((f.calls[0]!.body as { username: string }).username, "k");
});

test("never throws: a dead stream-api, a 5xx, and a dead pool all resolve", async () => {
  const restore = quiet();
  try {
    await createIdentityResolver({ pool: fakePool("Kay").pool, fetch: fakeFetch(200, { throws: true }).fetch }).resolveSiteIdentity("@k:site.test");
    await createIdentityResolver({ pool: fakePool("Kay").pool, fetch: fakeFetch(503).fetch }).resolveSiteIdentity("@k:site.test");
    await createIdentityResolver({ pool: fakePool("Kay", { throws: true }).pool, fetch: fakeFetch().fetch }).resolveSiteIdentity("@k:site.test");
  } finally { restore(); }
  assert.ok(true);
});

// Both callbacks call it AFTER the site.users insert, on every sign-in (not
// only a new row), and cannot be failed by it (the call sits in its own
// .catch). lockdown.test.ts pins checkSignupAllowed BEFORE the insert; this
// pins the resolve AFTER it.
for (const file of ["mas-callback", "matrix-callback"]) {
  test(`${file} announces the sign-in after the site.users insert`, () => {
    const p = path.join(process.cwd(), "app/api/auth", file, "route.ts");
    const src = stripComments(fs.readFileSync(p, "utf8"));
    const insert = src.indexOf("INSERT INTO site.users");
    const call = src.indexOf("resolveSiteIdentity(matrixId)");
    assert.notEqual(insert, -1, "insert literal moved — lockdown.test.ts scans it too");
    assert.notEqual(call, -1, "resolveSiteIdentity call missing");
    assert.ok(call > insert, "resolve must run after the insert");
    assert.match(src.slice(call, call + 80), /resolveSiteIdentity\(matrixId\)\.catch\(\(\) => \{\}\)/);
    // Review minor re-graded: a HUNG stream-api (not a down one) held every
    // sign-in for streamApiFetch's full 10 s. The resolve call gets its own
    // short cap.
    assert.match(src, /createIdentityResolver\(\{ pool, fetch: \(p, i\) => streamApiFetch\(p, i, RESOLVE_TIMEOUT_MS\) \}\)/, "built from the real pool and a capped stream-api fetch");
    assert.match(src, /import \{ createIdentityResolver, RESOLVE_TIMEOUT_MS \} from "@\/app\/lib\/identityResolveServer"/);
    assert.ok(src.trimEnd().endsWith("}"), "END anchor: the route file ends with a closing brace");
  });
}

test("the sign-in resolve cap is short — a hung stream-api must not hold a sign-in for 10 s", () => {
  assert.ok(RESOLVE_TIMEOUT_MS <= 2000 && RESOLVE_TIMEOUT_MS >= 500, String(RESOLVE_TIMEOUT_MS));
});
