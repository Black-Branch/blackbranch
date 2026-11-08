// The Matrix session's decisions (matrixSessionCore.ts), EXECUTED against an in-memory
// site.user_sessions ⋈ site.users and stub token/revocation endpoints. matrixSession.ts only wires
// these to @/auth, the pg pool and the real endpoints, so what is asserted here is what runs.
// Run: node --test app/lib/matrixSessionCore.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endSession, endUpstream, loadSessionRow, loadSessionRowsFor, logoutAt, resolveTokens, readRefreshAnswer, discoveredRevocationEndpoint,
  createSessionGetter, RevokedSessionError, SignedOutSessionError, RefreshRefusedError,
  type EndDeps, type SessionRow, type ResolveDeps, type DeviceStatus, type SiteSessionView,
} from "./matrixSessionCore.ts";
import { policyGatedSession } from "./federatedSignInSwitch.ts";

const OWN = "site.test";
const ME = "@casey:site.test";
const SID = "6f1c1e0a-2b7d-4c55-9a51-3c1f0d5e9b11";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: SID, matrix_id: ME, mx_device_id: "webDEVICE0001",
    mx_access_token: "at-1", mx_refresh_token: "rt-1", mx_token_expires: 0,
    homeserver: null, oidc_token_endpoint: null, oidc_client_id: null,
    ...over,
  };
}

/** A stored row: its oidc_* fields are the SESSION's own binding (v168); `user_oidc` is what the
 *  account's site.users columns hold (the binding of sessions from before v168). */
type StoredRow = SessionRow & { user_oidc?: { token: string | null; client: string | null } };

/** One table of session rows; answers the core's SQL by its shape, records every statement. */
function fakeDb(initial: StoredRow[] = [row()]) {
  const rows = new Map<string, StoredRow>(initial.map((r) => [r.session_id, { ...r }]));
  const log: string[] = [];
  const query = async (sql: string, params: unknown[]) => {
    log.push(sql.replace(/\s+/g, " ").trim());
    if (/^\s*SELECT/i.test(sql)) {
      // The columns as the loader's SELECT names them: the session's and the account's, apart.
      const shape = (r: StoredRow) => {
        const { oidc_token_endpoint, oidc_client_id, oidc_revocation_endpoint, user_oidc, ...rest } = r;
        return {
          ...rest,
          s_oidc_token_endpoint: oidc_token_endpoint, s_oidc_client_id: oidc_client_id, s_oidc_revocation_endpoint: oidc_revocation_endpoint ?? null,
          u_oidc_token_endpoint: user_oidc?.token ?? null, u_oidc_client_id: user_oidc?.client ?? null,
        };
      };
      // One account's every session (WHERE s.matrix_id = $1), or one session (session id, matrix id).
      if (/WHERE s\.matrix_id = \$1\s*$/.test(sql.trim())) {
        return { rows: [...rows.values()].filter((r) => r.matrix_id === params[0]).map(shape) };
      }
      const [sid, mx] = params as [string, string];
      const r = rows.get(sid);
      if (!r || r.matrix_id !== mx) return { rows: [] };
      return { rows: [shape(r)] };
    }
    if (/^\s*DELETE FROM site\.user_sessions WHERE session_id = \$1/i.test(sql)) {
      const had = rows.delete(params[0] as string);
      return { rows: [], rowCount: had ? 1 : 0 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { rows, log, query };
}

const HS_OWN = "https://matrix.site.test";

function endDeps(db: ReturnType<typeof fakeDb>, over: Partial<EndDeps> = {}) {
  const revoked: { token: string; at: string }[] = [];
  const loggedOut: { homeserver: string; token: string }[] = [];
  const order: string[] = [];
  const deps: EndDeps = {
    query: async (sql, params) => {
      if (/DELETE/.test(sql)) order.push("delete");
      return db.query(sql, params);
    },
    dec: (s) => s,
    revokeLocal: async (token) => { order.push("revoke"); revoked.push({ token, at: "local" }); return true; },
    revokeFederated: async (endpoint, _client, token) => { order.push("revoke"); revoked.push({ token, at: endpoint }); return true; },
    logout: async (homeserver, token) => { order.push("logout"); loggedOut.push({ homeserver, token }); return true; },
    homeserverFor: (r) => r.homeserver ?? HS_OWN,
    ownServer: OWN,
    log: () => {},
    ...over,
  };
  return { deps, revoked, loggedOut, order };
}

test("sign-out revokes the session's REFRESH token at the account server, then deletes the row", async () => {
  const db = fakeDb();
  const { deps, revoked, order } = endDeps(db);
  const r = await loadSessionRow(db.query, ME, SID);
  assert.ok(r, "vacuity: the row loads");
  await endSession(deps, r);
  assert.deepEqual(revoked, [{ token: "rt-1", at: "local" }], "the refresh token, not the access token");
  assert.deepEqual(order, ["revoke", "delete"], "the row holds the only copy of the refresh token: revoke first");
  assert.equal(db.rows.size, 0);
});

test("sign-out with a long-expired access token still ends the upstream session (no live access token needed)", async () => {
  const db = fakeDb([row({ mx_access_token: "expired-at", mx_token_expires: 1 })]);
  const { deps, revoked } = endDeps(db);
  await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
  assert.deepEqual(revoked.map((x) => x.token), ["rt-1"]);
});

test("local: a confirmed revocation needs no /logout", async () => {
  const db = fakeDb();
  const { deps, loggedOut } = endDeps(db);
  await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
  assert.equal(loggedOut.length, 0);
});

test("local: when the revocation is not confirmed, /logout with the access token is still tried at our homeserver", async () => {
  const db = fakeDb();
  const { deps, loggedOut, order } = endDeps(db, { revokeLocal: async () => { order.push("revoke"); return false; } });
  await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
  assert.deepEqual(loggedOut, [{ homeserver: HS_OWN, token: "at-1" }]);
  assert.deepEqual(order, ["revoke", "logout", "delete"]);
});

test("sign-out still deletes the row when nothing upstream confirms (the site sign-out never depends on the account server)", async () => {
  const logged: string[] = [];
  const db = fakeDb();
  const { deps } = endDeps(db, { revokeLocal: async () => false, logout: async () => false, log: (l) => logged.push(l) });
  await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
  assert.equal(db.rows.size, 0);
  assert.equal(logged.length, 1, "a failed upstream end is said once in the log");
  assert.match(logged[0] ?? "", /\[matrix-session\] sign-out: the account server did not confirm/);
  assert.doesNotMatch(logged[0] ?? "", /rt-1|at-1/, "no token in the log");
});

test("retry: signing out twice revokes once and the second is a quiet no-op", async () => {
  const db = fakeDb();
  const { deps, revoked } = endDeps(db);
  const first = await loadSessionRow(db.query, ME, SID);
  await endSession(deps, first!);
  const second = await loadSessionRow(db.query, ME, SID);
  assert.equal(second, null, "the row is gone after the first sign-out");
  assert.equal(revoked.length, 1);
});

test("restart: a new process ends a session it never refreshed — everything it needs is in the row", async () => {
  // A fresh module instance stands in for a restarted server: no in-memory state carries over.
  const fresh = await import(`./matrixSessionCore.ts?restart=${Date.now()}`) as typeof import("./matrixSessionCore.ts");
  const db = fakeDb();
  const { deps, revoked } = endDeps(db);
  await fresh.endSession(deps, (await fresh.loadSessionRow(db.query, ME, SID))!);
  assert.deepEqual(revoked.map((x) => x.token), ["rt-1"]);
  assert.equal(db.rows.size, 0);
});

test("no usable refresh token (none, or one that will not decrypt): /logout with the access token, then the row goes", async () => {
  for (const over of [{ mx_refresh_token: null }, { mx_refresh_token: "v1:garbage" }]) {
    const db = fakeDb([row(over)]);
    const { deps, revoked, loggedOut } = endDeps(db, { dec: (s) => (s && s.startsWith("v1:") ? null : s) });
    await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
    assert.equal(revoked.length, 0);
    assert.deepEqual(loggedOut, [{ homeserver: HS_OWN, token: "at-1" }]);
    assert.equal(db.rows.size, 0);
  }
});

// The outside-server paths, through the real request builders with an injectable transport.
const FED_HS = "https://matrix.gadget.test";
const FED_REVOKE = "https://auth.gadget.test/oauth2/revoke";
const fedRow = (over: Partial<SessionRow> = {}) => row({
  matrix_id: "@gadget:gadget.test", homeserver: FED_HS,
  oidc_token_endpoint: "https://auth.gadget.test/oauth2/token", oidc_client_id: "01GADGET", ...over,
});

function wireFetch(answer: (url: string) => number) {
  const seen: { url: string; auth: string | null; body: string }[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    seen.push({ url, auth: h.get("authorization"), body: String(init.body ?? "") });
    return new Response("{}", { status: answer(url) });
  };
  return { seen, fetchFn };
}

async function federatedEnd(r: SessionRow, answer: (url: string) => number) {
  const { revokeAt } = await import("./matrixOAuthClient.ts");
  const db = fakeDb([r]);
  const wire = wireFetch(answer);
  const { deps } = endDeps(db, {
    revokeFederated: (endpoint, clientId, token) => revokeAt(endpoint, null, token, "refresh_token", { client_id: clientId }, wire.fetchFn),
    logout: (hs, token) => logoutAt(hs, token, wire.fetchFn),
  });
  await endSession(deps, (await loadSessionRow(db.query, r.matrix_id, SID))!);
  return { db, seen: wire.seen };
}

test("federated: the refresh token is revoked at the OUTSIDE issuer's revocation endpoint, as our public client there", async () => {
  const { db, seen } = await federatedEnd(fedRow({ oidc_revocation_endpoint: FED_REVOKE }), () => 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, FED_REVOKE);
  assert.equal(seen[0]?.auth, null, "a public client sends no secret");
  const body = new URLSearchParams(seen[0]?.body);
  assert.deepEqual([body.get("token"), body.get("token_type_hint"), body.get("client_id")], ["rt-1", "refresh_token", "01GADGET"]);
  assert.equal(db.rows.size, 0);
});

test("federated: a refused revocation falls back to /logout at the account's own homeserver", async () => {
  const { seen } = await federatedEnd(fedRow({ oidc_revocation_endpoint: FED_REVOKE }), (u) => (u === FED_REVOKE ? 400 : 200));
  assert.deepEqual(seen.map((s) => s.url), [FED_REVOKE, `${FED_HS}/_matrix/client/v3/logout`]);
  assert.equal(seen[1]?.auth, "Bearer at-1");
});

test("federated: a session that recorded no revocation endpoint is ended by /logout at its homeserver", async () => {
  const { db, seen } = await federatedEnd(fedRow(), () => 200);
  assert.deepEqual(seen.map((s) => s.url), [`${FED_HS}/_matrix/client/v3/logout`]);
  assert.equal(seen[0]?.auth, "Bearer at-1");
  assert.equal(db.rows.size, 0);
});
// ─── Resolving a session's access token: every way it can end, classified ─────────────────────
//
// confirmed revoke (the account server says the device is gone) → RevokedSessionError: the row is
//   deleted and the browser wipes this device's crypto store;
// any other refusal → SignedOutSessionError: the row is deleted (signed out of the site) and the
//   browser KEEPS its store and device id, so the next sign-in resumes the same device;
// an operator fault (a stored token that will not decrypt) or an outage → a plain Error: nothing
//   is deleted, and an undecryptable token raises the operator alarm.

const NOW = 1_800_000_000_000;

const answer = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

test("the token endpoint's answer: invalid_grant / invalid_token are refusals with their description; anything else non-2xx is transient", async () => {
  await assert.rejects(readRefreshAnswer(answer(400, { error: "invalid_grant", error_description: "client id mismatch" }), 4096),
    (e) => e instanceof RefreshRefusedError && e.oauthError === "invalid_grant" && e.description === "client id mismatch");
  await assert.rejects(readRefreshAnswer(answer(401, { error: "invalid_token" }), 4096), (e) => e instanceof RefreshRefusedError && e.description === "");
  for (const [s, b] of [[400, { error: "invalid_client" }], [503, "upstream down"], [500, {}]] as const) {
    await assert.rejects(readRefreshAnswer(answer(s, b), 4096), (e) => e instanceof Error && !(e instanceof RefreshRefusedError), `${s}`);
  }
});

test("the token endpoint's answer: a 2xx without an access token, or over the cap, is transient — never a refusal", async () => {
  await assert.rejects(readRefreshAnswer(answer(200, { refresh_token: "x" }), 4096), (e) => !(e instanceof RefreshRefusedError));
  await assert.rejects(readRefreshAnswer(answer(200, { access_token: "a".repeat(5000) }), 4096), (e) => !(e instanceof RefreshRefusedError));
  // Over the cap, a refusal body is unreadable → transient too (nothing deleted on a body we could not read).
  await assert.rejects(readRefreshAnswer(answer(400, { error: "invalid_grant", pad: "p".repeat(5000) }), 4096), (e) => !(e instanceof RefreshRefusedError));
  assert.deepEqual(await readRefreshAnswer(answer(200, { access_token: "a", refresh_token: "r", expires_in: 300 }), 4096),
    { access_token: "a", refresh_token: "r", expires_in: 300 });
});

/** fakeDb plus the two UPDATEs the resolve writes. */
function fakeDbWithUpdate(initial: SessionRow[]) {
  const base = fakeDb(initial);
  const query = async (sql: string, params: unknown[]) => {
    if (/^\s*UPDATE site\.user_sessions\s+SET mx_access_token/i.test(sql)) {
      const r = base.rows.get(params[3] as string);
      if (r) Object.assign(r, { mx_access_token: params[0], mx_refresh_token: params[1], mx_token_expires: params[2] });
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (/^\s*UPDATE site\.user_sessions SET last_seen/i.test(sql)) return { rows: [], rowCount: 1 };
    return base.query(sql, params);
  };
  return { ...base, query };
}

function resolveFixture(rows: SessionRow[], over: Partial<ResolveDeps> = {}) {
  const db = fakeDbWithUpdate(rows);
  const calls = { refresh: [] as { kind: string; token: string }[], status: 0, alarms: [] as string[], logs: [] as string[] };
  const deps: ResolveDeps = {
    query: db.query,
    dec: (s) => (s && s.startsWith("v1:") ? null : s),
    enc: (s) => s,
    now: () => NOW,
    ownServer: OWN,
    refresh: async (path, token) => {
      calls.refresh.push({ kind: path.kind, token });
      return { access_token: `${token}-access`, refresh_token: `${token}-next`, expires_in: 300 };
    },
    deviceStatus: async () => { calls.status++; return "alive"; },
    alarm: (m) => calls.alarms.push(m),
    log: (l) => calls.logs.push(l),
    ...over,
  };
  return { db, deps, calls };
}

const refused = (error = "invalid_grant", description = "The provided access grant is invalid, expired, or revoked.") =>
  async (): Promise<never> => { throw new RefreshRefusedError(error, description); };
const notRevoked = (e: unknown) => e instanceof SignedOutSessionError && !(e instanceof RevokedSessionError);

test("a stored access token that is still fresh is returned without a refresh", async () => {
  const { deps, calls } = resolveFixture([row({ mx_token_expires: NOW + 120_000 })]);
  const got = await resolveTokens(deps, ME, SID);
  assert.equal(got.accessToken, "at-1");
  assert.equal(calls.refresh.length, 0);
});

test("an expired access token is refreshed and the rotated pair stored", async () => {
  const { db, deps, calls } = resolveFixture([row()]);
  const got = await resolveTokens(deps, ME, SID);
  assert.deepEqual(calls.refresh, [{ kind: "local", token: "rt-1" }]);
  assert.equal(got.accessToken, "rt-1-access");
  assert.equal(db.rows.get(SID)?.mx_refresh_token, "rt-1-next");
});

test("trigger (local refusal): our account server refuses the refresh AND confirms the device is gone → revoked, row deleted", async () => {
  const fx = resolveFixture([row()], { refresh: refused() });
  fx.deps.deviceStatus = async () => { fx.calls.status++; return "gone"; };
  await assert.rejects(resolveTokens(fx.deps, ME, SID), (e) => e instanceof RevokedSessionError && e.deviceId === "webDEVICE0001" && e.matrixId === ME);
  assert.equal(fx.calls.status, 1, "the account server was asked");
  assert.equal(fx.db.rows.size, 0);
});

for (const status of ["alive", "unknown"] as DeviceStatus[]) {
  test(`trigger (local refusal): refused but the device is ${status} → signed out, store KEPT`, async () => {
    const fx = resolveFixture([row()], { refresh: refused() });
    fx.deps.deviceStatus = async () => { fx.calls.status++; return status; };
    await assert.rejects(resolveTokens(fx.deps, ME, SID), notRevoked);
    assert.equal(fx.db.rows.size, 0, "signed out of the site: the row goes");
    assert.equal(fx.calls.logs.length, 1);
    assert.match(fx.calls.logs[0] ?? "", new RegExp(`^\\[matrix-session\\] refresh refused path=local device=webDEVICE0001 oauth_error=invalid_grant desc="The provided access grant is invalid, expired, or revoked\\." device=${status} → signed_out$`));
  });
}

test("trigger (local refusal): invalid_token from the token endpoint is a refusal like invalid_grant — never a wipe by itself", async () => {
  const { deps } = resolveFixture([row()], { refresh: refused("invalid_token", "x") });
  await assert.rejects(resolveTokens(deps, ME, SID), notRevoked);
});

test("a refused 'client id mismatch' (our own misconfiguration) never wipes while MAS still lists the device", async () => {
  const { deps } = resolveFixture([row()], { refresh: refused("invalid_grant", "client id mismatch") });
  await assert.rejects(resolveTokens(deps, ME, SID), notRevoked);
});

test("trigger (outside-server refusal): signed out, store kept, and nobody is asked about the device", async () => {
  const fed = row({ matrix_id: "@gadget:gadget.test", oidc_token_endpoint: "https://auth.gadget.test/oauth2/token", oidc_client_id: "01GADGET" });
  const { db, deps, calls } = resolveFixture([fed], { refresh: refused() });
  await assert.rejects(resolveTokens(deps, "@gadget:gadget.test", SID), notRevoked);
  assert.equal(calls.status, 0, "an outside server's devices cannot be confirmed from here");
  assert.equal(db.rows.size, 0);
});

test("an outside account's row is NEVER looked up at our MAS — even one missing a column, which refreshes on the local path", async () => {
  // refreshPathFor sends a foreign row missing oidc_client_id down the local path (the P14 fallback).
  // Its localpart named at OUR account server would be someone else's account here.
  const partial = row({ matrix_id: "@alice:other.example", oidc_token_endpoint: "https://auth.other.example/oauth2/token", oidc_client_id: null });
  const fx = resolveFixture([partial]);
  fx.deps.refresh = async (path, token) => { fx.calls.refresh.push({ kind: path.kind, token }); throw new RefreshRefusedError("invalid_grant", ""); };
  fx.deps.deviceStatus = async () => { fx.calls.status++; return "gone"; };
  await assert.rejects(resolveTokens(fx.deps, "@alice:other.example", SID), notRevoked);
  assert.deepEqual(fx.calls.refresh.map((c) => c.kind), ["local"], "vacuity: this row did take the local path");
  assert.equal(fx.calls.status, 0, "our MAS was not asked about another server's account");
  assert.match(fx.calls.logs[0] ?? "", /device=unknown → signed_out/);
});

test("trigger (undecryptable refresh token — a wrong or rotated TOKEN_ENC_KEY): transient + operator alarm; row and store kept", async () => {
  const { db, deps, calls } = resolveFixture([row({ mx_refresh_token: "v1:undecryptable" })]);
  await assert.rejects(resolveTokens(deps, ME, SID), (e) => e instanceof Error && !(e instanceof SignedOutSessionError));
  assert.equal(db.rows.size, 1, "the row is kept: the key, not the session, is wrong");
  assert.equal(calls.refresh.length, 0);
  assert.equal(calls.alarms.length, 1);
  assert.match(calls.alarms[0] ?? "", /TOKEN_ENC_KEY/);
});

test("a session row with no refresh token at all → signed out (nothing can renew it), never revoked", async () => {
  const { db, deps } = resolveFixture([row({ mx_refresh_token: null })]);
  await assert.rejects(resolveTokens(deps, ME, SID), notRevoked);
  assert.equal(db.rows.size, 0);
});

test("a missing row (signed out in another tab, or a re-sign-in rotated it) → signed out, never revoked", async () => {
  const { deps } = resolveFixture([]);
  await assert.rejects(resolveTokens(deps, ME, SID), notRevoked);
});

test("an outage at the token endpoint is transient: nothing deleted, the device is not asked about", async () => {
  const { db, deps, calls } = resolveFixture([row()], { refresh: async () => { throw new Error("refresh failed: 503"); } });
  await assert.rejects(resolveTokens(deps, ME, SID), /refresh failed: 503/);
  assert.equal(db.rows.size, 1);
  assert.equal(calls.status, 0);
});

test("retry: after a transient failure the next request refreshes with the same stored token and succeeds", async () => {
  let fail = true;
  const fx = resolveFixture([row()]);
  fx.deps.refresh = async (path, token) => {
    fx.calls.refresh.push({ kind: path.kind, token });
    if (fail) { fail = false; throw new Error("refresh failed: 502"); }
    return { access_token: "ok-access", refresh_token: "ok-next", expires_in: 300 };
  };
  await assert.rejects(resolveTokens(fx.deps, ME, SID));
  const got = await resolveTokens(fx.deps, ME, SID);
  assert.equal(got.accessToken, "ok-access");
  assert.deepEqual(fx.calls.refresh.map((c) => c.token), ["rt-1", "rt-1"]);
});

test("a refusal that lost a race to another process's rotation returns that process's fresh token, not a sign-out", async () => {
  const fx = resolveFixture([row()]);
  fx.deps.refresh = async () => {
    Object.assign(fx.db.rows.get(SID)!, { mx_access_token: "theirs", mx_refresh_token: "theirs-next", mx_token_expires: NOW + 290_000 });
    throw new RefreshRefusedError("invalid_grant", "already used");
  };
  const got = await resolveTokens(fx.deps, ME, SID);
  assert.equal(got.accessToken, "theirs");
  assert.equal(fx.db.rows.size, 1);
  assert.equal(fx.calls.status, 0);
});

test("restart: a new process resolves and refreshes from the row alone", async () => {
  const fresh = await import(`./matrixSessionCore.ts?restart2=${Date.now()}`) as typeof import("./matrixSessionCore.ts");
  const { deps, calls } = resolveFixture([row()]);
  const got = await fresh.resolveTokens(deps, ME, SID);
  assert.equal(got.accessToken, "rt-1-access");
  assert.equal(calls.refresh.length, 1);
});

// ─── A2-04: the client a session refreshes as is the SESSION's, not the account's ──────────────

const GADGET = "@gadget:gadget.test";
const GADGET_TOKEN = "https://auth.gadget.test/oauth2/token";

test("a second outside-server sign-in does not change the client the first device refreshes with", async () => {
  // Device A signed in under client CA; the account's columns now hold CB (any later sign-in's).
  const deviceA = row({
    matrix_id: GADGET, session_id: SID, mx_device_id: "webDEVICEA",
    oidc_token_endpoint: GADGET_TOKEN, oidc_client_id: "CA", oidc_revocation_endpoint: "https://auth.gadget.test/oauth2/revoke",
    user_oidc: { token: GADGET_TOKEN, client: "CB" },
  } as StoredRow);
  const fx = resolveFixture([deviceA]);
  const sent: unknown[] = [];
  fx.deps.refresh = async (path, token) => { sent.push(path); return { access_token: `${token}-a`, expires_in: 300 }; };
  await resolveTokens(fx.deps, GADGET, SID);
  assert.deepEqual(sent, [{ kind: "federated", tokenEndpoint: GADGET_TOKEN, clientId: "CA" }]);
});

test("a session from before v168 (no binding of its own) still refreshes with the account's columns", async () => {
  const legacy = row({ matrix_id: GADGET, user_oidc: { token: GADGET_TOKEN, client: "CU" } } as StoredRow);
  const fx = resolveFixture([legacy]);
  const sent: unknown[] = [];
  fx.deps.refresh = async (path) => { sent.push(path); return { access_token: "x", expires_in: 300 }; };
  await resolveTokens(fx.deps, GADGET, SID);
  assert.deepEqual(sent, [{ kind: "federated", tokenEndpoint: GADGET_TOKEN, clientId: "CU" }]);
});

test("the binding is taken whole: a session column never pairs with the account's other column", async () => {
  const half = row({ matrix_id: GADGET, oidc_token_endpoint: GADGET_TOKEN, oidc_client_id: null, user_oidc: { token: "https://old.test/oauth2/token", client: "CU" } } as StoredRow);
  const r = await loadSessionRow(fakeDb([half]).query, GADGET, SID);
  assert.deepEqual([r?.oidc_token_endpoint, r?.oidc_client_id, r?.oidc_revocation_endpoint], ["https://old.test/oauth2/token", "CU", null]);
});

// ─── 10-22 review step 2: every way a session row goes keeps an upstream end ───────────────────
//
// On prod (read 2026-10-31) every one of the 37 outside-server sessions predates v168 and recorded
// no revocation endpoint, so each sign-out fell back to /logout — which an OAuth 2.0 session on a
// MAS server (matrix.org's included) refuses: the session and its device stayed alive there.

const DISCOVERED = "https://auth.gadget.test/oauth2/revoke-discovered";

test("federated, recorded nothing (before v168): the revocation endpoint is discovered from the account's server and the refresh token revoked there", async () => {
  const { revokeAt } = await import("./matrixOAuthClient.ts");
  const db = fakeDb([fedRow()]);
  const wire = wireFetch(() => 200);
  const asked: { server: string; tokenEndpoint: string }[] = [];
  const { deps } = endDeps(db, {
    revokeFederated: (endpoint, clientId, token) => revokeAt(endpoint, null, token, "refresh_token", { client_id: clientId }, wire.fetchFn),
    logout: (hs, token) => logoutAt(hs, token, wire.fetchFn),
    discoverRevocation: async (r, tokenEndpoint) => { asked.push({ server: r.matrix_id, tokenEndpoint }); return DISCOVERED; },
  });
  await endSession(deps, (await loadSessionRow(db.query, "@gadget:gadget.test", SID))!);
  assert.deepEqual(asked, [{ server: "@gadget:gadget.test", tokenEndpoint: "https://auth.gadget.test/oauth2/token" }]);
  assert.deepEqual(wire.seen.map((s) => s.url), [DISCOVERED], "revoked at the discovered endpoint; no /logout needed");
  assert.equal(new URLSearchParams(wire.seen[0]?.body).get("client_id"), "01GADGET");
  assert.equal(db.rows.size, 0);
});

test("federated: a recorded revocation endpoint wins — nothing is discovered", async () => {
  const db = fakeDb([fedRow({ oidc_revocation_endpoint: FED_REVOKE })]);
  let asked = 0;
  const { deps, revoked } = endDeps(db, { discoverRevocation: async () => { asked++; return DISCOVERED; } });
  await endSession(deps, (await loadSessionRow(db.query, "@gadget:gadget.test", SID))!);
  assert.equal(asked, 0);
  assert.deepEqual(revoked, [{ token: "rt-1", at: FED_REVOKE }]);
});

test("federated: discovery that finds nothing, or fails, falls back to /logout and the row still goes", async () => {
  for (const discoverRevocation of [async () => null, async () => { throw new Error("unreachable"); }]) {
    const db = fakeDb([fedRow()]);
    const { deps, revoked, loggedOut } = endDeps(db, { discoverRevocation });
    await endSession(deps, (await loadSessionRow(db.query, "@gadget:gadget.test", SID))!);
    assert.equal(revoked.length, 0);
    assert.deepEqual(loggedOut, [{ homeserver: FED_HS, token: "at-1" }]);
    assert.equal(db.rows.size, 0);
  }
});

test("local: our own sessions never go through outside discovery", async () => {
  const db = fakeDb([row()]);
  let asked = 0;
  const { deps, revoked } = endDeps(db, { discoverRevocation: async () => { asked++; return DISCOVERED; } });
  await endSession(deps, (await loadSessionRow(db.query, ME, SID))!);
  assert.equal(asked, 0);
  assert.deepEqual(revoked, [{ token: "rt-1", at: "local" }]);
});

test("endUpstream ends the session upstream and leaves the row to its caller (re-sign-in and account deletion own their rows)", async () => {
  const db = fakeDb([row()]);
  const { deps, order } = endDeps(db);
  assert.equal(await endUpstream(deps, (await loadSessionRow(db.query, ME, SID))!), true);
  assert.deepEqual(order, ["revoke"]);
  assert.equal(db.rows.size, 1);
});

test("loadSessionRowsFor: every session of one account, each with its binding taken whole", async () => {
  const other = row({ session_id: "s-other", matrix_id: "@someone:site.test" });
  const legacy = { ...fedRow({ session_id: "s-legacy", oidc_token_endpoint: null, oidc_client_id: null }), user_oidc: { token: GADGET_TOKEN, client: "CU" } } as StoredRow;
  const own = fedRow({ session_id: "s-own", oidc_client_id: "CA", oidc_revocation_endpoint: FED_REVOKE });
  const rows = await loadSessionRowsFor(fakeDb([other, legacy, own]).query, "@gadget:gadget.test");
  assert.deepEqual(rows.map((r) => [r.session_id, r.oidc_client_id, r.oidc_revocation_endpoint]).sort(),
    [["s-legacy", "CU", null], ["s-own", "CA", FED_REVOKE]]);
});

// The production discovery's one rule: the endpoint is trusted only from an issuer that STILL names
// the session's token endpoint — a server that changed issuer since, or answers someone else's
// metadata, never receives the refresh token.
const metadata = (tokenEndpoint: string, revocationEndpoint: string | null) =>
  async () => ({ ok: true as const, metadata: { tokenEndpoint, revocationEndpoint } });

test("discovered revocation endpoint: used only when the server's issuer still names the session's token endpoint", async () => {
  assert.equal(await discoveredRevocationEndpoint("@gadget:gadget.test", GADGET_TOKEN, metadata(GADGET_TOKEN, DISCOVERED)), DISCOVERED);
  assert.equal(await discoveredRevocationEndpoint("@gadget:gadget.test", GADGET_TOKEN, metadata("https://elsewhere.test/oauth2/token", DISCOVERED)), null);
  assert.equal(await discoveredRevocationEndpoint("@gadget:gadget.test", GADGET_TOKEN, metadata(GADGET_TOKEN, null)), null);
  assert.equal(await discoveredRevocationEndpoint("@gadget:gadget.test", GADGET_TOKEN, async () => ({ ok: false as const })), null);
  assert.equal(await discoveredRevocationEndpoint("not-an-id", GADGET_TOKEN, metadata(GADGET_TOKEN, DISCOVERED)), null);
});

test("discovered revocation endpoint: it asks the server the ACCOUNT names", async () => {
  const asked: string[] = [];
  await discoveredRevocationEndpoint("@gadget:Gadget.Test", GADGET_TOKEN, async (s) => { asked.push(s); return { ok: false as const }; });
  assert.deepEqual(asked, ["gadget.test"]);
});

// ─── 10-22 review step 1: every decision leaves a journal line; refusals feed the rate alarm ──

const fetchFailed = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });

test("a transient refresh failure is logged with its path, the account's server, the device and the cause — and kept", async () => {
  const { db, deps, calls } = resolveFixture([row()], { refresh: async () => { throw fetchFailed("UND_ERR_CONNECT_TIMEOUT"); } });
  await assert.rejects(resolveTokens(deps, ME, SID));
  assert.equal(db.rows.size, 1);
  assert.deepEqual(calls.logs, ["[matrix-session] refresh failed path=local server=site.test device=webDEVICE0001 cause=UND_ERR_CONNECT_TIMEOUT → kept"]);
});

test("an outside server's transient failure names that server (the known expired-certificate noise is recognisable)", async () => {
  const fed = row({ matrix_id: "@gadget:gadget.test", oidc_token_endpoint: GADGET_TOKEN, oidc_client_id: "01GADGET" });
  const { deps, calls } = resolveFixture([fed], { refresh: async () => { throw fetchFailed("CERT_HAS_EXPIRED"); } });
  await assert.rejects(resolveTokens(deps, "@gadget:gadget.test", SID));
  assert.deepEqual(calls.logs, ["[matrix-session] refresh failed path=federated server=gadget.test device=webDEVICE0001 cause=CERT_HAS_EXPIRED → kept"]);
});

test("a transient failure without a cause code logs its message on one line", async () => {
  const { deps, calls } = resolveFixture([row()], { refresh: async () => { throw new Error("refresh failed: 503\nbody"); } });
  await assert.rejects(resolveTokens(deps, ME, SID));
  assert.match(calls.logs[0] ?? "", /cause="refresh failed: 503 body" → kept$/);
});

test("a row with no refresh token is logged when it is signed out", async () => {
  const { deps, calls } = resolveFixture([row({ mx_refresh_token: null })]);
  await assert.rejects(resolveTokens(deps, ME, SID), notRevoked);
  assert.deepEqual(calls.logs, ["[matrix-session] no refresh token server=site.test device=webDEVICE0001 → signed_out"]);
});

test("every refusal is reported to the rate watch with its account; transients and successes are not", async () => {
  const seen: string[] = [];
  const onRefusal = (m: string) => { seen.push(m); };
  const gone = resolveFixture([row()], { refresh: refused(), onRefusal });
  gone.deps.deviceStatus = async () => "gone";
  await assert.rejects(resolveTokens(gone.deps, ME, SID), (e) => e instanceof RevokedSessionError);
  await assert.rejects(resolveTokens(resolveFixture([row()], { refresh: refused(), onRefusal }).deps, ME, SID), notRevoked);
  await assert.rejects(resolveTokens(resolveFixture([row()], { refresh: async () => { throw new Error("503"); }, onRefusal }).deps, ME, SID));
  await resolveTokens(resolveFixture([row()], { onRefusal }).deps, ME, SID);
  assert.deepEqual(seen, [ME, ME]);
});

test("a refusal names its side: an account on our server is local; an outside account is federated (counted apart)", async () => {
  const sides: string[] = [];
  const onRefusal = (m: string, side: string) => { sides.push(`${m}:${side}`); };
  await assert.rejects(resolveTokens(resolveFixture([row()], { refresh: refused(), onRefusal }).deps, ME, SID));
  const fed = row({ matrix_id: "@gadget:gadget.test", oidc_token_endpoint: GADGET_TOKEN, oidc_client_id: "01GADGET" });
  await assert.rejects(resolveTokens(resolveFixture([fed], { refresh: refused(), onRefusal }).deps, "@gadget:gadget.test", SID));
  // An outside account missing a column takes the LOCAL refresh path — its side is still outside.
  const partial = row({ matrix_id: "@alice:other.example", oidc_token_endpoint: GADGET_TOKEN, oidc_client_id: null });
  await assert.rejects(resolveTokens(resolveFixture([partial], { refresh: refused(), onRefusal }).deps, "@alice:other.example", SID));
  assert.deepEqual(sides, [`${ME}:local`, "@gadget:gadget.test:federated", "@alice:other.example:federated"]);
});

// ─── 10-22 review step 3: the session getter (auth state → outcome, per-session dedup), executed ─

function getterFixture(view: SiteSessionView, over: { allowed?: (m: string) => boolean; resolve?: (m: string, s: string) => Promise<string> } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let current = view;
  const get = createSessionGetter<string>({
    auth: async () => current,
    resolve: over.resolve ?? (async (m, s) => { calls.push(`${m}/${s}`); return `tok:${s}`; }),
    gate: (m, load) => policyGatedSession(m, load, over.allowed ?? (() => true)),
    log: (l) => logs.push(l),
  });
  return { get, calls, logs, set: (v: SiteSessionView) => { current = v; } };
}

test("getter: no site session → null, nothing resolved", async () => {
  const fx = getterFixture(null);
  assert.equal(await fx.get(), null);
  assert.equal(await getterFixture({ user: {} }).get(), null);
  assert.deepEqual(fx.calls, []);
});

test("getter: a deleted account's cookie is revoked (and logged); a row gone elsewhere is signed out; an unavailable check is transient", async () => {
  const del = getterFixture({ authState: "deleted" });
  await assert.rejects(del.get(), (e) => e instanceof RevokedSessionError);
  assert.deepEqual(del.logs, ["[matrix-session] account deleted → revoked"]);
  await assert.rejects(getterFixture({ authState: "revoked" }).get(), (e) => e instanceof SignedOutSessionError && e.why === "no_row");
  await assert.rejects(getterFixture({ authState: "unavailable" }).get(), (e) => e instanceof Error && !(e instanceof SignedOutSessionError) && /unavailable/.test(e.message));
});

test("getter: concurrent calls for one session share ONE refresh (MAS rotates the refresh token on every use)", async () => {
  let release!: (v: string) => void;
  let started = 0;
  const fx = getterFixture({ user: { id: ME }, sessionId: SID }, { resolve: () => { started++; return new Promise((r) => { release = r; }); } });
  const a = fx.get(); const b = fx.get(); const c = fx.get();
  await new Promise((r) => setImmediate(r));
  assert.equal(started, 1);
  release("shared");
  assert.deepEqual(await Promise.all([a, b, c]), ["shared", "shared", "shared"]);
});

test("getter: two sessions never share a refresh", async () => {
  const fx = getterFixture({ user: { id: ME }, sessionId: "s1" });
  const a = fx.get();
  fx.set({ user: { id: ME }, sessionId: "s2" });
  const b = fx.get();
  assert.deepEqual(await Promise.all([a, b]), ["tok:s1", "tok:s2"]);
});

test("getter retry: after a failed resolve the next call resolves again (the dedup entry is cleared)", async () => {
  let n = 0;
  const fx = getterFixture({ user: { id: ME }, sessionId: SID }, { resolve: async () => { if (n++ === 0) throw new Error("503"); return "second"; } });
  await assert.rejects(fx.get(), /503/);
  assert.equal(await fx.get(), "second");
});

test("getter restart: a new process's getter has no entry from another — each resolves from the row", async () => {
  const one = getterFixture({ user: { id: ME }, sessionId: SID });
  const two = getterFixture({ user: { id: ME }, sessionId: SID });
  await one.get(); await two.get();
  assert.deepEqual([one.calls, two.calls], [[`${ME}/${SID}`], [`${ME}/${SID}`]]);
});

test("getter: the federated policy is asked before the load and again after it", async () => {
  const refusedFx = getterFixture({ user: { id: ME }, sessionId: SID }, { allowed: () => false });
  assert.equal(await refusedFx.get(), null);
  assert.deepEqual(refusedFx.calls, [], "refused before the load: nothing resolved");
  let first = true;
  const flipped = getterFixture({ user: { id: ME }, sessionId: SID }, { allowed: () => { const ok = first; first = false; return ok; } });
  assert.equal(await flipped.get(), null, "refused after the load: the token is not handed out");
});
