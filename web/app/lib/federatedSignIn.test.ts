// Federated sign-in (federatedSignIn.ts): the state cookie, the endpoint checks, the shared
// discovery, and the callback's decisions — driven with a stub fetch that records every outbound
// request, so "refused before any request" is a count, not a reading of the code.
// Run: node --test app/lib/federatedSignIn.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  signFedState, verifyFedState, fedStateSecret, initiateEndpointsProblem, discoverIssuer,
  completeFederatedCallback, federatedClientId, forgetFederatedClient, discoverServer, FED_STATE_TTL_S, type FedState, type Fetcher,
} from "./federatedSignIn.ts";
import { OWN_SERVER_SIGN_IN } from "./federatedSignInSwitch.ts";

const SECRET = "test-secret-not-a-real-one";
const T0 = 1_800_000_000_000;
const HS = "https://matrix.gadget.test";
const ISSUER = "https://auth.gadget.test/";

const STATE: FedState = {
  state: "st4te",
  codeVerifier: "verifier",
  tokenEndpoint: "https://auth.gadget.test/oauth2/token",
  homeserver: HS,
  clientId: "client-1",
  deviceId: "DEVICEABCDEF",
  serverName: "gadget.test",
  registrationEndpoint: "https://auth.gadget.test/oauth2/registration",
};

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: "https://auth.gadget.test/authorize",
  token_endpoint: "https://auth.gadget.test/oauth2/token",
  registration_endpoint: "https://auth.gadget.test/oauth2/registration",
};

type Route = (init: RequestInit) => Response;

/** A stub transport: a fixed answer per URL, and every call recorded. */
function stubFetch(routes: Record<string, Route>): { fetch: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetcher = async (url, init) => {
    calls.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r(init);
  };
  return { fetch, calls };
}

const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function happyRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [STATE.tokenEndpoint]: json({ access_token: "at", refresh_token: "rt", expires_in: 300 }),
    [`${HS}/_matrix/client/v3/account/whoami`]: json({ user_id: "@casey:gadget.test", device_id: STATE.deviceId }),
    "https://gadget.test/.well-known/matrix/client": json({ "m.homeserver": { base_url: HS } }),
    [`${HS}/_matrix/client/v1/auth_metadata`]: json(METADATA),
    ...overrides,
  };
}

const log = { error: () => {} };
const deps = (fetch: Fetcher, over: Partial<Parameters<typeof completeFederatedCallback>[1]> = {}) => ({
  fetch, secret: SECRET, now: () => T0 + 1000, redirectUri: "https://site.test/api/auth/matrix-callback", log,
  serverAllowed: () => true, isOwnServer: (s: string) => s === "site.test", ...over,
});

test("an account on this install's own server is refused by the federated callback with a 'use Sign in' code, before any request", async () => {
  const own: FedState = { ...STATE, serverName: "Site.Test", homeserver: "https://matrix.site.test" };
  const { fetch, calls } = stubFetch(happyRoutes());
  const out = await completeFederatedCallback({ code: "c", state: own.state, cookie: signFedState(own, SECRET, T0) }, deps(fetch, { isOwnServer: (s) => s.toLowerCase() === "site.test" }));
  assert.deepEqual(out, { ok: false, error: OWN_SERVER_SIGN_IN });
  assert.equal(calls.length, 0, `fetched ${calls.join(", ")} — no code exchange, no client chain written`);
  // The same login for an outside server still goes through (the refusal is for our own name only).
  const other = stubFetch(happyRoutes());
  assert.equal((await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(other.fetch))).ok, true);
});

// ─── The cookie ───────────────────────────────────────────────────────────────

test("a signed cookie verifies and round-trips its fields", () => {
  const v = verifyFedState(signFedState(STATE, SECRET, T0), SECRET, T0 + 1000);
  assert.deepEqual(v, { ok: true, data: STATE });
});

test("the callback refuses a forged UNSIGNED cookie (the old plain-JSON shape) with no outbound request", async () => {
  const { fetch, calls } = stubFetch(happyRoutes());
  const forged = JSON.stringify({ ...STATE, tokenEndpoint: "https://attacker.test/token" });
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: forged }, deps(fetch));
  assert.deepEqual(out, { ok: false, error: "invalid_state" });
  assert.equal(calls.length, 0, `fetched ${calls.join(", ")}`);
});

test("the callback refuses a tampered field under a valid-looking signature with no outbound request", async () => {
  const { fetch, calls } = stubFetch(happyRoutes());
  const [v, issued, , sig] = signFedState(STATE, SECRET, T0).split(".");
  const swapped = Buffer.from(JSON.stringify({ ...STATE, tokenEndpoint: "https://attacker.test/token" })).toString("base64url");
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: [v, issued, swapped, sig].join(".") }, deps(fetch));
  assert.deepEqual(out, { ok: false, error: "invalid_state" });
  // A fresh issued-at under the old signature is a tamper too.
  const [, , payload] = signFedState(STATE, SECRET, T0).split(".");
  const refreshed = [v, String(T0 + 500), payload, sig].join(".");
  assert.deepEqual(await completeFederatedCallback({ code: "c", state: STATE.state, cookie: refreshed }, deps(fetch)), { ok: false, error: "invalid_state" });
  // So is a cookie signed with another secret.
  const other = signFedState(STATE, "another-secret", T0);
  assert.deepEqual(await completeFederatedCallback({ code: "c", state: STATE.state, cookie: other }, deps(fetch)), { ok: false, error: "invalid_state" });
  assert.equal(calls.length, 0, `fetched ${calls.join(", ")}`);
});

test("the callback refuses an EXPIRED but correctly signed cookie with no outbound request", async () => {
  const { fetch, calls } = stubFetch(happyRoutes());
  const cookie = signFedState(STATE, SECRET, T0);
  const late = await completeFederatedCallback({ code: "c", state: STATE.state, cookie }, deps(fetch, { now: () => T0 + FED_STATE_TTL_S * 1000 + 1 }));
  assert.deepEqual(late, { ok: false, error: "session_expired" });
  const future = await completeFederatedCallback({ code: "c", state: STATE.state, cookie }, deps(fetch, { now: () => T0 - 60_000 }));
  assert.deepEqual(future, { ok: false, error: "session_expired" }, "an issued-at far in the future is not a fresh cookie");
  assert.equal(calls.length, 0, `fetched ${calls.join(", ")}`);
});

test("no secret, no cookie, or a state mismatch: refused with no outbound request", async () => {
  const { fetch, calls } = stubFetch(happyRoutes());
  const cookie = signFedState(STATE, SECRET, T0);
  assert.deepEqual(await completeFederatedCallback({ code: "c", state: STATE.state, cookie }, deps(fetch, { secret: null })), { ok: false, error: "unavailable" });
  assert.deepEqual(await completeFederatedCallback({ code: "c", state: STATE.state, cookie: undefined }, deps(fetch)), { ok: false, error: "session_expired" });
  assert.deepEqual(await completeFederatedCallback({ code: "c", state: "other", cookie }, deps(fetch)), { ok: false, error: "state_mismatch" });
  assert.equal(calls.length, 0);
});

test("fedStateSecret reuses the site's Auth.js secret and has no fallback of its own", () => {
  assert.equal(fedStateSecret({ AUTH_SECRET: "a" }), "a");
  assert.equal(fedStateSecret({ AUTH_SECRET_1: "b" }), "b");
  assert.equal(fedStateSecret({}), null);
});

// ─── The callback, past the cookie ────────────────────────────────────────────

test("a genuine sign-in passes, binding the token endpoint to the vouched homeserver's issuer", async () => {
  const { fetch, calls } = stubFetch(happyRoutes());
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(fetch));
  assert.equal(out.ok, true, JSON.stringify(out));
  if (!out.ok) return;
  assert.equal(out.matrixId, "@casey:gadget.test");
  assert.equal(out.tokenEndpoint, STATE.tokenEndpoint);
  assert.deepEqual(out.tokens, { access_token: "at", refresh_token: "rt", expires_in: 300 });
  assert.deepEqual(calls, [
    STATE.tokenEndpoint,
    `${HS}/_matrix/client/v3/account/whoami`,
    "https://gadget.test/.well-known/matrix/client",
    `${HS}/_matrix/client/v1/auth_metadata`,
  ]);
});

test("the callback records the vouched issuer's revocation endpoint with the session's binding (null when it publishes none)", async () => {
  const withRevoke = stubFetch(happyRoutes({ [`${HS}/_matrix/client/v1/auth_metadata`]: json({ ...METADATA, revocation_endpoint: "https://auth.gadget.test/oauth2/revoke" }) }));
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(withRevoke.fetch));
  assert.equal(out.ok && out.revocationEndpoint, "https://auth.gadget.test/oauth2/revoke");
  assert.equal(out.ok && out.clientId, STATE.clientId);
  const without = stubFetch(happyRoutes());
  const none = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(without.fetch));
  assert.equal(none.ok && none.revocationEndpoint, null);
});

test("the callback names a client the outside server no longer knows (invalid_client) — the registry entry it came from — so the site registers afresh", async () => {
  const { fetch } = stubFetch(happyRoutes({ [STATE.tokenEndpoint]: json({ error: "invalid_client" }, 401) }));
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(fetch));
  assert.deepEqual(out, {
    ok: false, error: "token_exchange_failed",
    forgetClient: { registrationEndpoint: STATE.registrationEndpoint, clientId: STATE.clientId },
  });
});

test("invalid_client from a token endpoint that is not the vouched server's issuer forgets nothing: a refusal and a journal line", async () => {
  const errors: unknown[][] = [];
  // The state's token endpoint answers invalid_client, but gadget.test's own issuer is elsewhere.
  const { fetch } = stubFetch(happyRoutes({
    [STATE.tokenEndpoint]: json({ error: "invalid_client" }, 401),
    [`${HS}/_matrix/client/v1/auth_metadata`]: json({ ...METADATA, issuer: "https://login.gadget-elsewhere.test/", authorization_endpoint: "https://login.gadget-elsewhere.test/a", token_endpoint: "https://login.gadget-elsewhere.test/t", registration_endpoint: "https://login.gadget-elsewhere.test/r" }),
  }));
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(fetch, { log: { error: (...a: unknown[]) => errors.push(a) } }));
  assert.deepEqual(out, { ok: false, error: "issuer_mismatch" });
  assert.ok(errors.some((a) => String(a[0]).includes("REJECTED")), "the refusal is in the journal");
});

test("initiate's endpoints are the server's own (discoverServer from its name), never the browser's", async () => {
  const { fetch } = stubFetch(happyRoutes());
  const found = await discoverServer("gadget.test", fetch);
  assert.ok(found.ok);
  assert.equal(found.ok && found.homeserver, HS);
  assert.deepEqual(found.ok && [found.metadata.authorizationEndpoint, found.metadata.tokenEndpoint, found.metadata.registrationEndpoint],
    [METADATA.authorization_endpoint, METADATA.token_endpoint, METADATA.registration_endpoint]);
  const dead = stubFetch({});
  assert.deepEqual(await discoverServer("gadget.test", dead.fetch), { ok: false, error: "well_known_unreachable" });
});

// ─── One client per outside server (A2-04) ────────────────────────────────────

/** site.oauth_clients in memory, answering federatedClientId's three statements. */
function clientTable() {
  const rows = new Map<string, string>();
  const key = (p: unknown[]) => `${p[0]}\n${p[1]}`;
  const query = async (sql: string, params: unknown[]) => {
    if (/^\s*SELECT client_id FROM site\.oauth_clients WHERE registration_endpoint = \$1 AND redirect_uri = \$2/i.test(sql)) {
      const c = rows.get(key(params));
      return { rows: c ? [{ client_id: c }] : [] };
    }
    if (/^\s*INSERT INTO site\.oauth_clients \(registration_endpoint, redirect_uri, client_id\)[\s\S]*ON CONFLICT \(registration_endpoint, redirect_uri\) DO NOTHING/i.test(sql)) {
      if (rows.has(key(params))) return { rows: [] };
      rows.set(key(params), params[2] as string);
      return { rows: [{ client_id: params[2] }] };
    }
    if (/^\s*DELETE FROM site\.oauth_clients WHERE registration_endpoint = \$1 AND redirect_uri = \$2 AND client_id = \$3/i.test(sql)) {
      if (rows.get(key(params)) === params[2]) rows.delete(key(params));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { rows, query };
}

const REG = METADATA.registration_endpoint;
const REDIRECT = "https://site.test/api/auth/matrix-callback";

test("the first sign-in to an outside server registers this site once; every later one — any member, any device — reuses it", async () => {
  const t = clientTable();
  let registrations = 0;
  const register = async () => `client-${++registrations}`;
  const first = await federatedClientId({ query: t.query, register }, REG, REDIRECT);
  const second = await federatedClientId({ query: t.query, register }, REG, REDIRECT);
  assert.equal(first, "client-1");
  assert.equal(second, "client-1", "the second device signs in as the same client");
  assert.equal(registrations, 1);
  // Another server, or another redirect (a dev origin), is its own registration.
  assert.equal(await federatedClientId({ query: t.query, register }, "https://auth.other.test/oauth2/registration", REDIRECT), "client-2");
  assert.equal(await federatedClientId({ query: t.query, register }, REG, "http://localhost:3002/api/auth/matrix-callback"), "client-3");
});

test("two first sign-ins racing: both use the one client that was stored", async () => {
  const t = clientTable();
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const register = async () => { const id = `client-${++n}`; await gate; return id; };
  const a = federatedClientId({ query: t.query, register }, REG, REDIRECT);
  const b = federatedClientId({ query: t.query, register }, REG, REDIRECT);
  release();
  const [ca, cb] = await Promise.all([a, b]);
  assert.equal(ca, cb, "one stored client, whichever registration lost");
  assert.equal(t.rows.size, 1);
});

test("restart: a new process reuses the stored client (nothing about it lives in memory)", async () => {
  const t = clientTable();
  await federatedClientId({ query: t.query, register: async () => "client-1" }, REG, REDIRECT);
  const fresh = await import(`./federatedSignIn.ts?restart=${Date.now()}`) as typeof import("./federatedSignIn.ts");
  assert.equal(await fresh.federatedClientId({ query: t.query, register: async () => assert.fail("registered again") }, REG, REDIRECT), "client-1");
});

test("retry: a registration that fails stores nothing, and the next sign-in registers", async () => {
  const t = clientTable();
  await assert.rejects(federatedClientId({ query: t.query, register: async () => { throw new Error("registration failed: 503"); } }, REG, REDIRECT));
  assert.equal(t.rows.size, 0);
  assert.equal(await federatedClientId({ query: t.query, register: async () => "client-ok" }, REG, REDIRECT), "client-ok");
  // A client the server forgot is dropped, so the next sign-in registers afresh.
  await forgetFederatedClient(t.query, { registrationEndpoint: REG, redirectUri: REDIRECT, clientId: "client-ok" });
  assert.equal(await federatedClientId({ query: t.query, register: async () => "client-new" }, REG, REDIRECT), "client-new");
});

test("forgetting is keyed by the registry entry: another server's entry with the same client id string is untouched", async () => {
  const t = clientTable();
  // A hostile server answered its registration with another server's client id.
  await federatedClientId({ query: t.query, register: async () => "shared-id" }, REG, REDIRECT);
  await federatedClientId({ query: t.query, register: async () => "shared-id" }, "https://auth.evil.test/register", REDIRECT);
  await forgetFederatedClient(t.query, { registrationEndpoint: "https://auth.evil.test/register", redirectUri: REDIRECT, clientId: "shared-id" });
  assert.equal(t.rows.size, 1);
  assert.equal(await federatedClientId({ query: t.query, register: async () => assert.fail("re-registered") }, REG, REDIRECT), "shared-id");
});

test("R2-11: a token endpoint off the vouched issuer's origin is refused and never stored", async () => {
  const st = { ...STATE, tokenEndpoint: "https://elsewhere.test/oauth2/token" };
  const { fetch } = stubFetch(happyRoutes({ [st.tokenEndpoint]: json({ access_token: "at", expires_in: 0 }) }));
  const out = await completeFederatedCallback({ code: "c", state: st.state, cookie: signFedState(st, SECRET, T0) }, deps(fetch));
  assert.deepEqual(out, { ok: false, error: "issuer_mismatch" });
});

test("a token bound to another device is refused before the homeserver is even resolved", async () => {
  const { fetch, calls } = stubFetch(happyRoutes({
    [`${HS}/_matrix/client/v3/account/whoami`]: json({ user_id: "@casey:gadget.test", device_id: "SOMEOTHERDEVICE" }),
  }));
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(fetch));
  assert.deepEqual(out, { ok: false, error: "device_mismatch" });
  assert.equal(calls.length, 2, "token + whoami only");
});

test("a homeserver that does not vouch for the MXID is refused", async () => {
  const { fetch } = stubFetch(happyRoutes({
    "https://gadget.test/.well-known/matrix/client": json({ "m.homeserver": { base_url: "https://other.test" } }),
  }));
  const out = await completeFederatedCallback({ code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) }, deps(fetch));
  assert.deepEqual(out, { ok: false, error: "homeserver_mismatch" });
});

test("a token error body is logged at most 2 KiB", async () => {
  const lines: unknown[][] = [];
  const { fetch } = stubFetch(happyRoutes({ [STATE.tokenEndpoint]: () => new Response("e".repeat(100_000), { status: 400 }) }));
  const out = await completeFederatedCallback(
    { code: "c", state: STATE.state, cookie: signFedState(STATE, SECRET, T0) },
    deps(fetch, { log: { error: (...a: unknown[]) => { lines.push(a); } } }),
  );
  assert.deepEqual(out, { ok: false, error: "token_exchange_failed" });
  const logged = String(lines[0]?.[2] ?? "");
  assert.equal(logged.length, 2048);
});

// ─── R2-6: `javascript:` endpoints ────────────────────────────────────────────

test("R2-6: the openid-configuration fallback is validated — a javascript: authorize endpoint is refused", async () => {
  const wellKnown = { "m.homeserver": { base_url: HS }, "m.authentication": { issuer: ISSUER } };
  const { fetch } = stubFetch({
    [`${HS}/_matrix/client/v1/auth_metadata`]: json({ errcode: "M_UNRECOGNIZED" }, 404),
    "https://auth.gadget.test/.well-known/openid-configuration": json({ ...METADATA, authorization_endpoint: "javascript:alert(document.domain)//" }),
  });
  assert.deepEqual(await discoverIssuer(HS, wellKnown, fetch), { ok: false, error: "oidc_invalid" });
});

test("the openid-configuration fallback passes a valid document, and refuses one naming another issuer", async () => {
  const wellKnown = { "m.authentication": { issuer: ISSUER } };
  const ok = stubFetch({
    [`${HS}/_matrix/client/v1/auth_metadata`]: json({}, 404),
    "https://auth.gadget.test/.well-known/openid-configuration": json(METADATA),
  });
  const found = await discoverIssuer(HS, wellKnown, ok.fetch);
  assert.equal(found.ok && found.metadata.authorizationEndpoint, METADATA.authorization_endpoint);
  const moved = stubFetch({
    [`${HS}/_matrix/client/v1/auth_metadata`]: json({}, 404),
    "https://auth.gadget.test/.well-known/openid-configuration": json({
      issuer: "https://attacker.test/", authorization_endpoint: "https://attacker.test/a", token_endpoint: "https://attacker.test/t",
    }),
  });
  assert.deepEqual(await discoverIssuer(HS, wellKnown, moved.fetch), { ok: false, error: "oidc_invalid" });
});

test("R2-6: matrix-initiate refuses a javascript: (or any non-https, or split-origin) endpoint", () => {
  const good = {
    authorizationEndpoint: METADATA.authorization_endpoint,
    tokenEndpoint: METADATA.token_endpoint,
    registrationEndpoint: METADATA.registration_endpoint,
  };
  assert.equal(initiateEndpointsProblem(good), null);
  assert.match(initiateEndpointsProblem({ ...good, authorizationEndpoint: "javascript:alert(document.domain)//" }) ?? "", /authorizationEndpoint/);
  assert.match(initiateEndpointsProblem({ ...good, tokenEndpoint: "http://auth.gadget.test/oauth2/token" }) ?? "", /tokenEndpoint/);
  assert.match(initiateEndpointsProblem({ ...good, authorizationEndpoint: "https://u:p@auth.gadget.test/a" }) ?? "", /authorizationEndpoint/);
  assert.match(initiateEndpointsProblem({ ...good, registrationEndpoint: "https://elsewhere.test/r" }) ?? "", /different origins/);
  assert.match(initiateEndpointsProblem({ ...good, registrationEndpoint: null }) ?? "", /missing registrationEndpoint/);
});
