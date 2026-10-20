// Federated sign-in (federatedSignIn.ts): the state cookie, the endpoint checks, the shared
// discovery, and the callback's decisions — driven with a stub fetch that records every outbound
// request, so "refused before any request" is a count, not a reading of the code.
// Run: node --test app/lib/federatedSignIn.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  signFedState, verifyFedState, fedStateSecret, initiateEndpointsProblem, discoverIssuer,
  completeFederatedCallback, FED_STATE_TTL_S, type FedState, type Fetcher,
} from "./federatedSignIn.ts";

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
  serverAllowed: () => true, ...over,
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
