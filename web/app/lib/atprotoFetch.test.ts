// The fetch every atproto request goes through (handle, DID document, OAuth metadata, token,
// PDS session). Those URLs and bodies come from servers a signed-in user can run: a handle
// resolving to did:web:<their domain> makes the site fetch and parse whatever that domain serves.
// Run: env -u DATABASE_URL node --test app/lib/atprotoFetch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedState } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { atprotoFetch, makeAtprotoFetch } from "./atprotoFetch.ts";
import { stripComments } from "./sourceText.mjs";

const CAP = 512 * 1024;

/** An inner fetch that records whether the wrapper let a request through. */
function recorder(body: () => BodyInit = () => "{}") {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return new Response(body(), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

/** Every message down an error's cause chain, so a refusal can be told from a connection error. */
function causes(e: unknown): string {
  const out: string[] = [];
  for (let c = e as { message?: string; cause?: unknown } | undefined; c; c = c.cause as typeof c) out.push(String(c.message));
  return out.join(" <- ");
}

// The address policy lives in the connection dispatcher (it covers redirect hops too), so these use
// the real fetch: a stubbed inner fetch never reaches it. Asserting the REASON matters — a loopback
// port with nothing listening would also reject, with a connection error, and prove nothing.
test("a private, loopback or link-local address is refused by policy, not by a failed connection", async () => {
  for (const url of [
    "https://127.0.0.1/.well-known/did.json",
    "https://10.0.0.1/.well-known/did.json",
    "https://192.168.1.1/xrpc/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/.well-known/did.json",
  ]) {
    const err = await atprotoFetch(url, { redirect: "error" }).then(() => null, (e: unknown) => e);
    assert.ok(err, `${url} was fetched`);
    assert.match(causes(err), /Blocked by url policy .*non-unicast/, `${url} was not refused by the address policy: ${causes(err)}`);
  }
  const local = await atprotoFetch("https://localhost/.well-known/did.json", { redirect: "error" }).then(() => null, (e: unknown) => e);
  assert.match(causes(local), /not a public domain/, `localhost was not refused by policy: ${causes(local)}`);
});

// Inside the Next server, globalThis.fetch is Next's patched fetch. In a route handler (a work store
// is set) it rebuilds a Request from a fixed field list and drops the `dispatcher` the address policy
// rides on, so a private target would be connected to. This runs the wrapper through Next's own
// createPatchedFetcher with a route-handler store set: the refusal must still be the policy's.
test("inside a Next route handler (patched fetch, request context set) a private address is still refused by policy", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  // Next's storage modules read this global when they load; the server sets it at boot.
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
  const require = createRequire(import.meta.url);
  const { createPatchedFetcher } = require("next/dist/server/lib/patch-fetch.js");
  const { createDedupeFetch } = require("next/dist/server/lib/dedupe-fetch.js");
  const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
  const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
  const native = globalThis.fetch;
  const patched = createPatchedFetcher(createDedupeFetch(native), { workAsyncStorage, workUnitAsyncStorage });
  const routeStore = { route: "/api/auth/link/streamplace/initiate", page: "/api/auth/link/streamplace/initiate/route",
    isDraftMode: false, nextFetchId: 1, forceDynamic: true, pendingRevalidates: {}, pendingRevalidateWrites: [] };
  globalThis.fetch = patched;
  try {
    for (const url of ["https://127.0.0.1/.well-known/did.json", "https://10.0.0.1/.well-known/did.json"]) {
      const err = await workAsyncStorage.run(routeStore, () =>
        atprotoFetch(url, { redirect: "error" }).then(() => null, (e: unknown) => e));
      assert.match(causes(err), /Blocked by url policy .*non-unicast/,
        `${url} through Next's patched fetch was not refused by the address policy (the dispatcher was dropped): ${causes(err)}`);
    }
    // The bare-Request shape the OAuth client's DPoP wrapper uses, which is the one Next rebuilds.
    const err = await workAsyncStorage.run(routeStore, () =>
      atprotoFetch(new Request("https://127.0.0.1/xrpc/com.atproto.repo.createRecord", { method: "POST", body: "{}" })).then(() => null, (e: unknown) => e));
    assert.match(causes(err), /Blocked by url policy .*non-unicast/, `a bare Request through Next's patched fetch: ${causes(err)}`);
    // Control: a plain fetch in the same store takes Next's request-context path (it numbers the
    // fetch), so the store above is live and the internal flag is what kept the dispatcher.
    await workAsyncStorage.run(routeStore, () => patched("https://127.0.0.1:1/", { redirect: "error" }).catch(() => null));
    assert.ok(routeStore.nextFetchId > 1, "vacuity: Next's fetch never took its request-context path in this harness");
  } finally {
    globalThis.fetch = native;
  }
});

test("a non-default https port is refused (an internal service on its own port is not reachable either)", async () => {
  const r = recorder();
  const err = await makeAtprotoFetch(r.fetch)("https://pds.example.test:8443/xrpc/x", { redirect: "error" }).then(() => null, (e: unknown) => e);
  assert.match(causes(err), /Custom https: ports not allowed/);
  assert.deepEqual(r.calls, []);
});

test("plain http and odd schemes are refused", async () => {
  for (const url of ["http://example.test/.well-known/did.json", "file:///etc/passwd", "data:application/json,{}"]) {
    const r = recorder();
    await assert.rejects(makeAtprotoFetch(r.fetch)(url, { redirect: "error" }), `${url} was not refused`);
    assert.deepEqual(r.calls, []);
  }
});

test(`a response body over ${CAP} bytes is refused; one at the cap is read`, async () => {
  const at = recorder(() => "x".repeat(CAP));
  assert.equal((await (await makeAtprotoFetch(at.fetch)("https://example.test/a", { redirect: "error" })).text()).length, CAP);
  const over = recorder(() => "x".repeat(CAP + 1));
  await assert.rejects(async () => {
    const res = await makeAtprotoFetch(over.fetch)("https://example.test/a", { redirect: "error" });
    await res.text();
  }, "a body one byte over the cap was read whole");
  // Streamed with no Content-Length: the cap is enforced while reading, not only from the header.
  const streamed = recorder(() => new ReadableStream({
    start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(64 * 1024)); c.close(); },
  }));
  await assert.rejects(async () => {
    const res = await makeAtprotoFetch(streamed.fetch)("https://example.test/a", { redirect: "error" });
    await res.arrayBuffer();
  }, "a streamed 576 kB body was read whole");
});

test("a Request with no redirect mode (how the OAuth client's DPoP wrapper calls) goes through", async () => {
  // @atproto/oauth-client's token, PAR and PDS requests hand fetch a bare Request. The wrapper's
  // default refuses those; ours must not, or linking and posting to stream.place would fail.
  const r = recorder();
  const res = await makeAtprotoFetch(r.fetch)(new Request("https://pds.example.test/xrpc/com.atproto.repo.createRecord", { method: "POST", body: "{}" }));
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls, ["https://pds.example.test/xrpc/com.atproto.repo.createRecord"]);
});

test("an OAuth client built the way atprotoClient.ts builds it uses the wrapped fetch, not globalThis.fetch", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  // The key as the site imports its own (atprotoClient.ts parses ATPROTO_PRIVATE_JWK into a plain object).
  const jwk: unknown = JSON.parse(JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "key1" }));
  const key = await JoseKey.fromImportable(jwk as Parameters<typeof JoseKey.fromImportable>[0], "key1");
  const store = <V,>() => {
    const m = new Map<string, V>();
    return { get: async (k: string) => m.get(k), set: async (k: string, v: V) => void m.set(k, v), del: async (k: string) => void m.delete(k) };
  };
  const client = new NodeOAuthClient({
    clientMetadata: {
      client_id: "https://site.example.test/oauth/client-metadata.json",
      redirect_uris: ["https://site.example.test/api/auth/link/streamplace/callback"],
      scope: "atproto transition:generic", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      application_type: "web", token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_signing_alg: "ES256",
      dpop_bound_access_tokens: true, jwks_uri: "https://site.example.test/oauth/jwks.json",
    },
    keyset: [key],
    handleResolver: "https://bsky.social",
    stateStore: store<NodeSavedState>(),
    sessionStore: store<NodeSavedSession>(),
    requestLock: async (_name, fn) => fn(),
    fetch: atprotoFetch,
  });
  assert.notEqual(client.fetch, globalThis.fetch);
  // Resolving a did:web on a private address fails inside the client's own resolver, by policy.
  const err = await client.oauthResolver.resolve("did:web:10.0.0.1").then(() => null, (e: unknown) => e);
  assert.match(causes(err), /non-unicast/, `the client's resolver did not use the wrapped fetch: ${causes(err)}`);
});

test("atprotoClient.ts hands the OAuth client the wrapped fetch, and no atproto object gets another", () => {
  const src = stripComments(readFileSync(new URL("./atprotoClient.ts", import.meta.url), "utf8"));
  const ctor = /new NodeOAuthClient\(\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? "";
  assert.ok(ctor.includes("keyset"), "vacuity: the NodeOAuthClient options were not found");
  assert.match(ctor, /\bfetch: atprotoFetch\b/, "NodeOAuthClient is built without the wrapped fetch: it falls back to globalThis.fetch");
  assert.match(src, /import \{ atprotoFetch \} from "\.\/atprotoFetch\.ts";/);
  // platformChat.ts posts through `new Agent(oauthSession)`: the session carries the client's fetch.
  const chat = stripComments(readFileSync(new URL("./platformChat.ts", import.meta.url), "utf8"));
  const agents = chat.match(/new (?:Atp)?Agent\(([^)]*)\)/g) ?? [];
  assert.deepEqual(agents, ["new Agent(oauthSession)"], "an atproto Agent is built from something other than the OAuth session");
  // Vacuity anchor: the client module was read to its end.
  assert.match(src, /return clientPromise;\n\}\s*$/, "vacuity: atprotoClient.ts was not read to its end");
});
