// The username colour's Matrix copy. The profile-field API (MSC4133) wants the body keyed by the
// field name, and a field is cleared with DELETE — a writer that sends `{ color }` is refused
// with 400, and one that clears with an empty string clears nothing, so no colour would ever
// reach Matrix. The real server's answer is pinned by the homeserver suite; this pins the request
// the site sends.
// Run: node --test app/lib/matrixProfile.test.ts
import "./testInstallValues.ts";
import "./legacyNamespace.setup.test.ts"; // next: the read-both install (a legacy prefix is set)
import "./testTsx.ts";
import test from "node:test";
import assert from "node:assert/strict";

const { setMatrixColor } = await import("@/app/lib/matrixProfile");

const HS = "https://matrix.example.tv"; // testInstallValues's matrix.baseUrl: our own homeserver, plain fetch
const FIELD = "app.blackbranch.username_color";

function stubFetch(status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? "{}" : '{"errcode":"M_MISSING_PARAM"}', { status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("a colour is PUT under the product field, with the body keyed by the field name", async () => {
  const f = stubFetch();
  try {
    assert.equal(await setMatrixColor(HS, "@a:example.tv", "tok", "#123456"), true);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0]!;
  assert.equal(url, `${HS}/_matrix/client/v3/profile/${encodeURIComponent("@a:example.tv")}/${FIELD}`);
  assert.equal(init.method, "PUT");
  assert.deepEqual(JSON.parse(String(init.body)), { [FIELD]: "#123456" });
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tok");
});

test("clearing the colour DELETEs the field (MSC4133) — never an empty string", async () => {
  const f = stubFetch();
  try {
    assert.equal(await setMatrixColor(HS, "@a:example.tv", "tok", null), true);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0]!;
  assert.ok(url.endsWith(`/${FIELD}`), url);
  assert.equal(init.method, "DELETE");
  assert.equal(init.body, undefined);
});

test("a refused write reports false (callers fire and forget, but the result is honest)", async () => {
  const f = stubFetch(400);
  try {
    assert.equal(await setMatrixColor(HS, "@a:example.tv", "tok", "#123456"), false);
  } finally { f.restore(); }
});
