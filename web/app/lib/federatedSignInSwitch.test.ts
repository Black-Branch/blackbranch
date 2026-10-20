// The federated sign-in switch (auth.federatedSignin / auth.federatedAllow / auth.federatedDeny):
// who may sign in with an account on another Matrix server, and who may stay signed in.
// The policy, the callback, the per-request session check and the session gate are RUN; the three
// routes and the session caches (which import through the @/ alias) are scanned.
// Run: node --test app/lib/federatedSignInSwitch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";
import {
  serverAllowed, serverNameOf, normalizeServerName, federatedPolicyVersion, policyGatedSession,
  federatedServerAllowed, FEDERATED_SIGNIN_REFUSED, type FederatedPolicy,
} from "./federatedSignInSwitch.ts";
import { completeFederatedCallback, signFedState, type FedState, type Fetcher } from "./federatedSignIn.ts";
import { sessionFromToken } from "./siteSession.ts";
import { instanceEntry, parseInstanceValue } from "./instanceSchema.generated.mjs";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const OWN = "site.test";
const policy = (over: Partial<FederatedPolicy> = {}): FederatedPolicy => ({ mode: "off", allow: [], deny: [], own: OWN, ...over });

// ─── The policy ───────────────────────────────────────────────────────────────

test("off: only this site's own server signs in", () => {
  const p = policy();
  assert.equal(serverAllowed(p, OWN), true, "turning federated sign-in off leaves the site's own sign-in alone");
  assert.equal(serverAllowed(p, "gadget.test"), false);
  assert.equal(serverAllowed(p, "matrix.org"), false);
});

test("on: any server not on the deny list", () => {
  const p = policy({ mode: "on" });
  assert.equal(serverAllowed(p, "gadget.test"), true);
  assert.equal(serverAllowed(p, OWN), true);
});

test("allowlist admits only the listed servers", () => {
  const p = policy({ mode: "allowlist", allow: ["gadget.test", "Widget.Test"] });
  assert.equal(serverAllowed(p, "gadget.test"), true);
  assert.equal(serverAllowed(p, "widget.test"), true, "the list is matched case-insensitively too");
  assert.equal(serverAllowed(p, "other.test"), false);
  assert.equal(serverAllowed(p, OWN), true, "the site's own server needs no listing");
  assert.equal(serverAllowed(policy({ mode: "allowlist" }), "gadget.test"), false, "an empty allow list admits no one else");
});

test("the denylist refuses in every mode — but never the site's own server", () => {
  for (const mode of ["off", "on", "allowlist"] as const) {
    const p = policy({ mode, allow: ["gadget.test"], deny: ["gadget.test"] });
    assert.equal(serverAllowed(p, "gadget.test"), false, mode);
  }
  assert.equal(serverAllowed(policy({ mode: "on", deny: [OWN] }), OWN), true, "a deny entry cannot lock the site out of its own sign-in");
});

test("server-name matching is exact and case-insensitive, with no suffix or prefix matching", () => {
  const allow = policy({ mode: "allowlist", allow: ["example.test"] });
  assert.equal(serverAllowed(allow, "EXAMPLE.test"), true);
  assert.equal(serverAllowed(allow, "evil-example.test"), false);
  assert.equal(serverAllowed(allow, "chat.example.test"), false);
  assert.equal(serverAllowed(allow, "example.test.evil.test"), false);
  assert.equal(serverAllowed(allow, "example.test:8448"), false, "a port is part of the server name");
  const deny = policy({ mode: "on", deny: ["example.test"] });
  assert.equal(serverAllowed(deny, "Example.Test"), false);
  assert.equal(serverAllowed(deny, "evil-example.test"), true, "a deny entry does not spread to look-alikes either");
  assert.equal(serverAllowed(deny, "sub.example.test"), true);
  // Names are read from the account id, never a URL.
  assert.equal(serverNameOf("@casey:Gadget.Test"), "gadget.test");
  assert.equal(serverNameOf("@casey:gadget.test:8448"), "gadget.test:8448");
  for (const bad of ["casey:gadget.test", "@casey", "@:gadget.test", "@casey:https://gadget.test", "@casey:gadget.test/x", 42, null]) {
    assert.equal(serverNameOf(bad), null, String(bad));
  }
  assert.equal(normalizeServerName(" [::1]:8448 "), "[::1]:8448");
  assert.equal(serverAllowed(policy({ mode: "on" }), "not a server"), false);
});

test("a fresh install reads off: nothing set means only its own server", () => {
  for (const k of ["AUTH_FEDERATED_SIGNIN", "AUTH_FEDERATED_ALLOW", "AUTH_FEDERATED_DENY"]) delete process.env[k];
  assert.equal(federatedServerAllowed("gadget.test"), false);
});

test("the settings reach the policy: mode and lists from the settings layer (env here)", () => {
  process.env.AUTH_FEDERATED_SIGNIN = "allowlist";
  process.env.AUTH_FEDERATED_ALLOW = "gadget.test,widget.test";
  process.env.AUTH_FEDERATED_DENY = "widget.test";
  try {
    assert.equal(federatedServerAllowed("gadget.test"), true);
    assert.equal(federatedServerAllowed("widget.test"), false, "deny wins over allow");
    assert.equal(federatedServerAllowed("other.test"), false);
    process.env.AUTH_FEDERATED_SIGNIN = "on";
    assert.equal(federatedServerAllowed("other.test"), true);
  } finally {
    for (const k of ["AUTH_FEDERATED_SIGNIN", "AUTH_FEDERATED_ALLOW", "AUTH_FEDERATED_DENY"]) delete process.env[k];
  }
});

// ─── The two lists, at write time ─────────────────────────────────────────────
// A list entry that is not a server name normalises to nothing at check time and matches no one,
// so a malformed DENY entry failed open. The settings layer refuses one when it is written.

test("a malformed server name is refused when either list is written (Admin Panel or env)", () => {
  for (const key of ["auth.federatedAllow", "auth.federatedDeny"]) {
    const e = instanceEntry(key);
    assert.ok(e, key);
    for (const bad of ["https://bad.example", "bad.example.", "@x:bad.example", "bad.example/path", "bad example", "-bad.example", "bad..example", "x".repeat(256)]) {
      const r = parseInstanceValue(e, [bad]);
      assert.equal(r.ok, false, `${key} accepted ${bad}`);
      assert.equal(parseInstanceValue(e, `good.example,${bad}`).ok, false, `${key} accepted ${bad} from env`);
    }
    // What IS a server name is kept, in the one form the policy compares.
    assert.deepEqual(parseInstanceValue(e, [" Bad.Example ", "bad.example", "chat.bad.example:8448", "[::1]:8448", ""]),
      { ok: true, value: ["bad.example", "chat.bad.example:8448", "[::1]:8448"] });
  }
});

test("a stored entry matches at check time: the check-time normaliser IS the schema's", () => {
  const e = instanceEntry("auth.federatedDeny");
  assert.ok(e);
  const r = parseInstanceValue(e, ["Bad.Example", "other.example:8448"]);
  assert.ok(r.ok);
  const deny = r.value as string[];
  for (const mode of ["off", "on", "allowlist"] as const) {
    const p = policy({ mode, allow: ["bad.example"], deny });
    assert.equal(serverAllowed(p, "bad.example"), false, mode);
    assert.equal(serverAllowed(p, "BAD.example"), false, mode);
    assert.equal(serverAllowed(p, "other.example:8448"), false, mode);
  }
  for (const x of ["Bad.Example", "https://bad.example", "bad.example.", "@x:bad.example", "[::1]:8448", " a.b ", ""]) {
    const parsed = parseInstanceValue(e, [x]);
    assert.equal(normalizeServerName(x), parsed.ok ? (parsed.value as string[])[0] ?? null : null, x);
  }
});

test("a deny list that cannot be read refuses every other server: it never fails open", () => {
  process.env.AUTH_FEDERATED_SIGNIN = "on";
  process.env.AUTH_FEDERATED_DENY = "https://bad.example";
  try {
    assert.equal(federatedServerAllowed("gadget.test"), false, "an unreadable deny list must not admit everyone");
    assert.equal(federatedServerAllowed("bad.example"), false);
  } finally {
    for (const k of ["AUTH_FEDERATED_SIGNIN", "AUTH_FEDERATED_DENY"]) delete process.env[k];
  }
});

// ─── The three sign-in steps ──────────────────────────────────────────────────

test("off refuses at discover and initiate, on the server asked for, before anything is fetched", () => {
  const discover = read("app", "api", "auth", "matrix-discover", "route.ts");
  assert.match(discover, /\}, \{ headers: \{ "Cache-Control": "no-store" \} \}\);\n\}\n$/, "END of discover not read");
  const d = stripComments(discover);
  assert.match(d, /const serverName = normalizeServerName\(match\[1\]\);/);
  assert.match(d, /if \(!federatedServerAllowed\(serverName\)\) return Response\.json\(\{ error: FEDERATED_SIGNIN_REFUSED \}, \{ status: 403 \}\);/);
  assert.ok(d.indexOf("federatedServerAllowed(serverName)") < d.indexOf("safeFetch("), "checked before the first outbound request");

  const initiate = read("app", "api", "auth", "matrix-initiate", "route.ts");
  assert.match(initiate, /return Response\.json\(\{ authorizationUrl: url\.toString\(\) \}\);\n\}\n$/, "END of initiate not read");
  const i = stripComments(initiate);
  assert.match(i, /const serverName = normalizeServerName\(body\.serverName\);\s*if \(!serverName\) return Response\.json\(\{ error: "missing_fields" \}, \{ status: 400 \}\);\s*if \(!federatedServerAllowed\(serverName\)\) return Response\.json\(\{ error: FEDERATED_SIGNIN_REFUSED \}, \{ status: 403 \}\);/);
  assert.ok(i.indexOf("federatedServerAllowed(serverName)") < i.indexOf("safeFetch("), "checked before registration");
  assert.match(i, /signFedState\(\{[^}]*serverName \}, secret\)/, "the server asked for is signed into the state cookie");
  assert.equal(FEDERATED_SIGNIN_REFUSED, "federated_signin_disabled");
});

const SECRET = "test-secret-not-a-real-one";
const T0 = 1_800_000_000_000;
const HS = "https://matrix.gadget.test";
const STATE: FedState = {
  state: "st4te", codeVerifier: "verifier", tokenEndpoint: "https://auth.gadget.test/oauth2/token",
  homeserver: HS, clientId: "client-1", deviceId: "DEVICEABCDEF", serverName: "gadget.test",
};
function stub(userId: string): { fetch: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    [STATE.tokenEndpoint]: { access_token: "at", refresh_token: "rt", expires_in: 300 },
    [`${HS}/_matrix/client/v3/account/whoami`]: { user_id: userId, device_id: STATE.deviceId },
    "https://gadget.test/.well-known/matrix/client": { "m.homeserver": { base_url: HS } },
    [`${HS}/_matrix/client/v1/auth_metadata`]: {
      issuer: "https://auth.gadget.test/", authorization_endpoint: "https://auth.gadget.test/authorize",
      token_endpoint: STATE.tokenEndpoint, registration_endpoint: "https://auth.gadget.test/oauth2/registration",
    },
  };
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      if (!(url in answers)) throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify(answers[url]), { headers: { "content-type": "application/json" } });
    },
  };
}
const callback = (fetch: Fetcher, serverAllowedNow: (s: string) => boolean, state: FedState = STATE) => completeFederatedCallback(
  { code: "c0de", state: state.state, cookie: signFedState(state, SECRET, T0) },
  { fetch, secret: SECRET, now: () => T0 + 1000, redirectUri: "https://site.test/api/auth/matrix-callback", log: { error: () => {} }, serverAllowed: serverAllowedNow },
);

test("off refuses at the callback — the authenticated account's server, under the policy as it is now", async () => {
  const off = policy();
  const { fetch } = stub("@casey:gadget.test");
  assert.deepEqual(await callback(fetch, (s) => serverAllowed(off, s)), { ok: false, error: FEDERATED_SIGNIN_REFUSED });
  const on = policy({ mode: "on" });
  const ok = await callback(stub("@casey:gadget.test").fetch, (s) => serverAllowed(on, s));
  assert.equal(ok.ok, true, "the same login passes when the server is admitted");
});

test("a login in flight when the policy tightens is refused at the callback", async () => {
  // initiate admitted gadget.test (mode on) and signed the cookie; then the server was denied.
  let current = policy({ mode: "on" });
  assert.equal(serverAllowed(current, STATE.serverName), true, "initiate's provisional check passed");
  current = policy({ mode: "on", deny: ["gadget.test"] });
  const { fetch, calls } = stub("@casey:gadget.test");
  assert.deepEqual(await callback(fetch, (s) => serverAllowed(current, s)), { ok: false, error: FEDERATED_SIGNIN_REFUSED });
  assert.ok(!calls.some((u) => u.includes(".well-known")), "refused before the homeserver is even resolved");
});

test("a login cannot start on one server and finish as an account on another", async () => {
  const on = policy({ mode: "on" });
  const out = await callback(stub("@casey:widget.test").fetch, (s) => serverAllowed(on, s));
  assert.deepEqual(out, { ok: false, error: "server_mismatch" });
  const upper = await callback(stub("@casey:GADGET.test").fetch, (s) => serverAllowed(on, s));
  assert.notEqual((upper as { error?: string }).error, "server_mismatch", "case alone is not a different server");
});

test("the callback route hands the policy to the callback, and the callback checks it before any write", () => {
  const route = stripComments(read("app", "api", "auth", "matrix-callback", "route.ts"));
  assert.match(route, /serverAllowed: federatedServerAllowed \}/);
  assert.ok(route.indexOf("completeFederatedCallback(") < route.indexOf("INSERT INTO site.users"));
});

// ─── Sessions already signed in ───────────────────────────────────────────────

const SID = "6f1c1e0a-2b7d-4c55-9a51-3c1f0d5e9b11";
const freshSession = () => ({ user: { name: "casey" } as { name: string; id?: string }, expires: "2099-01-01T00:00:00.000Z" }) as Parameters<typeof sessionFromToken>[0];

test("an existing session from a denied server is refused on validation — at its next request, without the database", async () => {
  let current = policy({ mode: "on" });
  const queries: string[] = [];
  const query = async (sql: string) => { queries.push(sql); return { rows: [{ deleted: false }] }; };
  const allowed = (mx: string) => serverAllowed(current, serverNameOf(mx));
  const live = await sessionFromToken(freshSession(), { sub: "@casey:gadget.test", sessionId: SID }, query, allowed);
  assert.equal(live.user.id, "@casey:gadget.test");
  current = policy({ mode: "on", deny: ["gadget.test"] });
  const next = await sessionFromToken(freshSession(), { sub: "@casey:gadget.test", sessionId: SID }, query, allowed);
  assert.equal(next.user.id, undefined);
  assert.equal(next.authState, "refused", "signed out — NOT revoked, so the browser's crypto store is not wiped");
  assert.equal(queries.length, 1, "the refusal needs no query");
  const own = await sessionFromToken(freshSession(), { sub: `@kit:${OWN}`, sessionId: SID }, query, allowed);
  assert.equal(own.user.id, `@kit:${OWN}`, "the site's own accounts are untouched");
});

test("refresh: a Matrix session load is refused before it starts and after it settles, when the policy changed meanwhile", async () => {
  let current = policy({ mode: "on" });
  const allowed = (mx: string) => serverAllowed(current, serverNameOf(mx));
  assert.deepEqual(await policyGatedSession("@casey:gadget.test", async () => ({ token: "t" }), allowed), { token: "t" });
  let started = false;
  current = policy({ mode: "on", deny: ["gadget.test"] });
  assert.equal(await policyGatedSession("@casey:gadget.test", async () => { started = true; return { token: "t" }; }, allowed), null);
  assert.equal(started, false, "no refresh is started for a refused server");
  // A refresh already in flight when the policy tightens never hands its token out.
  current = policy({ mode: "on" });
  let release!: () => void;
  const inFlight = new Promise<{ token: string }>((r) => { release = () => r({ token: "fresh" }); });
  const pending = policyGatedSession("@casey:gadget.test", () => inFlight, allowed);
  current = policy({ mode: "off" });
  release();
  assert.equal(await pending, null);
});

test("getMatrixSession runs every load — the in-flight refresh map included — through the gate", () => {
  const raw = read("app", "lib", "matrixSession.ts");
  assert.match(raw, /export async function destroyMatrixSession/, "END of matrixSession.ts read");
  const src = stripComments(raw);
  assert.match(src, /return policyGatedSession\(matrixId, \(\) => \{\s*const existing = inFlight\.get\(sessionId\);\s*if \(existing\) return existing;/);
  assert.match(src, /if \(session\?\.authState === "revoked"\) throw new RevokedSessionError\(\);/, "a refused session is not answered as revoked");
});

test("session caches compare the policy version: any change to the policy is a miss", () => {
  const base = policy({ mode: "allowlist", allow: ["a.test", "b.test"] });
  assert.equal(federatedPolicyVersion(base), federatedPolicyVersion({ ...base, allow: ["b.test", "a.test"] }), "order alone is no change");
  for (const changed of [
    { ...base, mode: "on" as const }, { ...base, allow: ["a.test"] }, { ...base, deny: ["c.test"] }, { ...base, own: "other.test" },
  ]) assert.notEqual(federatedPolicyVersion(changed), federatedPolicyVersion(base));
  const media = read("app", "api", "matrix", "media", "[...path]", "route.ts");
  assert.match(media, /return new Response\(null, \{ status: 404 \}\);\n\}\n$/, "END of the media route read");
  const m = stripComments(media);
  assert.match(m, /if \(cached && cached\.until > Date\.now\(\) && cached\.policy === federatedPolicyVersion\(\)\) \{/);
  assert.equal(m.match(/sessionCache\.set\(matrixId, \{ \.\.\.mx, until: Date\.now\(\) \+ CACHE_TTL_MS, policy: federatedPolicyVersion\(\) \}\);/g)?.length, 2,
    "every write stamps the policy");
  assert.equal(m.match(/sessionCache\.set\(/g)?.length, 2);
});

test("the sign-in page says so, and asks before signing anyone out", () => {
  const raw = read("app", "(main)", "auth", "signin", "SignInForm.tsx");
  const src = stripComments(raw);
  assert.match(src, /const SERVER_NOT_ENABLED = "Sign-in from this server isn't enabled on this site\.";/);
  assert.match(src, /federated_signin_disabled: SERVER_NOT_ENABLED,/);
  assert.match(src, /new URLSearchParams\(window\.location\.search\)\.get\("error"\)/);
  assert.ok(src.indexOf("/api/auth/matrix-discover") < src.indexOf("await signOut("), "discovery (and its refusal) comes before the sign-out");
});
