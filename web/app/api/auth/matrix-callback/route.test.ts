// Source scan: the route is plumbing around completeFederatedCallback (federatedSignIn.ts, where
// the decisions are tested with a stub fetch). What only the route can get wrong is ORDER — the
// per-IP limit must run before the cookie is read, and nothing may be written unless the
// decisions passed — and that the state cookie is read by the signed verifier, never JSON.parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
import { endReplacedSession, type SessionRow, type UpstreamDeps, type Query } from "../../../lib/matrixSessionCore.ts";
import { createSessionAlarms } from "../../../lib/matrixSessionWatch.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);

test("the callback is rate limited per IP before it reads the state cookie", () => {
  assert.match(src, /const isRateLimited = createSlidingWindowLimiter\(60_000, \d+\);/);
  const limit = src.indexOf("isRateLimited(ipKey(req))");
  const cookie = src.indexOf("cookieStore.get(FED_STATE_COOKIE)");
  assert.ok(limit > 0, "no per-IP limit on the callback");
  assert.ok(cookie > limit, "the cookie is read before the limit is checked");
});

test("the state cookie goes through the signed verifier, never JSON.parse", () => {
  assert.doesNotMatch(src, /JSON\.parse/);
  assert.match(src, /completeFederatedCallback\(/);
  assert.match(src, /secret: fedStateSecret\(\)/);
  assert.match(src, /fetch: \(url, init\) => safeFetch\(url, init\)/);
});

// ─── Re-sign-in on the same device: the old chain is REVOKED at its issuer, never /logout ──────
// The route calls endReplacedSession (matrixSessionCore.ts); these run it. /logout deletes the
// device at the homeserver, and the new session keeps the same device id — so on this path a
// revocation that is not confirmed leaves the old chain alone rather than taking the device.
const ME = "@gadget:gadget.test";
const DEVICE = "webDEVICE0001";
const TOKEN_EP = "https://auth.gadget.test/oauth2/token";
const REVOKE_EP = "https://auth.gadget.test/oauth2/revoke";

type Prior = Partial<SessionRow> & { user_oidc?: { token: string | null; client: string | null } };

/** priorDb for another account (the burst test). */
function priorDbFor(matrixId: string) {
  const base = priorDb({ matrix_id: matrixId });
  return (sql: string, params: unknown[]) => base(sql, [params[0] === matrixId ? ME : params[0], ...params.slice(1)]);
}

/** site.user_sessions ⋈ site.users with at most one prior row for (ME, DEVICE). */
function priorDb(prior: Prior | null) {
  const r = prior && {
    session_id: "s-old", matrix_id: ME, mx_device_id: DEVICE,
    mx_access_token: "old-access", mx_refresh_token: "old-refresh", mx_token_expires: Date.now() + 250_000,
    homeserver: "https://matrix.gadget.test", oidc_token_endpoint: TOKEN_EP, oidc_client_id: "01GADGET", oidc_revocation_endpoint: REVOKE_EP,
    ...prior,
  };
  return async (sql: string, params: unknown[]) => {
    if (/SELECT session_id FROM site\.user_sessions WHERE matrix_id = \$1 AND mx_device_id = \$2/.test(sql)) {
      return { rows: r && params[0] === ME && params[1] === DEVICE ? [{ session_id: r.session_id }] : [] };
    }
    if (/WHERE s\.session_id = \$1 AND s\.matrix_id = \$2/.test(sql)) {
      if (!r || params[0] !== r.session_id) return { rows: [] };
      const { oidc_token_endpoint, oidc_client_id, oidc_revocation_endpoint, user_oidc, ...rest } = r;
      return { rows: [{ ...rest,
        s_oidc_token_endpoint: oidc_token_endpoint, s_oidc_client_id: oidc_client_id, s_oidc_revocation_endpoint: oidc_revocation_endpoint,
        u_oidc_token_endpoint: user_oidc?.token ?? null, u_oidc_client_id: user_oidc?.client ?? null }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

function wired(prior: Prior | null, over: Partial<UpstreamDeps> = {}) {
  const calls = { revoked: [] as string[], logout: 0, logs: [] as string[], unconfirmed: [] as string[], sides: [] as string[] };
  const deps: UpstreamDeps & { query: Query; onUnconfirmed: (m: string, side: "local" | "federated") => void } = {
    onUnconfirmed: (m, side) => { calls.unconfirmed.push(m); calls.sides.push(side); },
    query: priorDb(prior),
    dec: (x) => x,
    revokeLocal: async (t) => { calls.revoked.push(`local:${t}`); return true; },
    revokeFederated: async (ep, _c, t) => { calls.revoked.push(`${ep}:${t}`); return true; },
    logout: async () => { calls.logout++; return true; },
    homeserverFor: (row) => row.homeserver ?? "https://matrix.site.test",
    ownServer: "site.test",
    log: (l) => calls.logs.push(l),
    ...over,
  };
  return { deps, calls };
}

test("re-sign-in: the old chain's refresh token is revoked at ITS recorded issuer", async () => {
  const { deps, calls } = wired({});
  assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), true);
  assert.deepEqual(calls.revoked, [`${REVOKE_EP}:old-refresh`]);
  assert.equal(calls.logout, 0);
});

test("re-sign-in: a refused revocation with a still-valid old access token is NOT followed by /logout (the device is the new session's)", async () => {
  const { deps, calls } = wired({}, { revokeFederated: async (ep, _c, t) => { calls.revoked.push(`${ep}:${t}`); return false; } });
  assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), false);
  assert.equal(calls.revoked.length, 1, "vacuity: the revocation was tried");
  assert.equal(calls.logout, 0);
  assert.match(calls.logs[0] ?? "", /re-sign-in: .*no \/logout/);
});

test("re-sign-in: an old row with no refresh token is left alone — no /logout with its access token", async () => {
  const { deps, calls } = wired({ mx_refresh_token: null });
  assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), false);
  assert.deepEqual([calls.revoked, calls.logout], [[], 0]);
});

test("re-sign-in: a pre-v168 row whose revocation endpoint cannot be discovered gets no /logout", async () => {
  const legacy = { oidc_token_endpoint: null, oidc_client_id: null, oidc_revocation_endpoint: null, user_oidc: { token: TOKEN_EP, client: "01GADGET" } };
  for (const discoverRevocation of [async () => null, async () => { throw new Error("unreachable"); }]) {
    const { deps, calls } = wired(legacy, { discoverRevocation });
    assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), false);
    assert.deepEqual([calls.revoked, calls.logout], [[], 0]);
  }
});

test("re-sign-in: an own-server row is revoked at our server, never /logout", async () => {
  const { deps, calls } = wired({ matrix_id: ME }, { ownServer: "gadget.test", revokeLocal: async () => false });
  await endReplacedSession(deps, ME, DEVICE, "new-refresh");
  assert.equal(calls.logout, 0);
});

test("re-sign-in: nothing to end — no prior row, or the prior row already holds the new chain", async () => {
  for (const [prior, fresh] of [[null, "new-refresh"], [{}, "old-refresh"]] as const) {
    const { deps, calls } = wired(prior);
    assert.equal(await endReplacedSession(deps, ME, DEVICE, fresh), false);
    assert.deepEqual([calls.revoked, calls.logout], [[], 0]);
  }
});

test("retry: a database error while reading the old row never fails the sign-in", async () => {
  const { deps, calls } = wired({}, {});
  deps.query = async () => { throw new Error("connection reset"); };
  assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), false);
  assert.equal(calls.logout, 0);
});

// An old chain that could NOT be revoked is still live at its issuer with no row pointing at it:
// it must leave a journal line that says where and why, and count toward the burst alarm.

test("re-sign-in: an unconfirmed revocation is logged with the path, the issuer and the server's error, and counted", async () => {
  const { deps, calls } = wired({}, {
    revokeFederated: async (ep) => ({ ok: false, error: "invalid_client", description: "client authentication failed", endpoint: ep }),
  });
  assert.equal(await endReplacedSession(deps, ME, DEVICE, "new-refresh"), false);
  assert.deepEqual(calls.logs, [
    `[matrix-session] re-sign-in: old chain NOT revoked path=federated issuer=https://auth.gadget.test device=${DEVICE} oauth_error=invalid_client desc="client authentication failed" → left live at the account server (no /logout: the device is the new session's)`,
  ]);
  assert.deepEqual(calls.unconfirmed, [ME]);
  assert.equal(calls.logout, 0);
});

test("re-sign-in: every unconfirmed reason is logged and counted — no refresh token, no endpoint, a database error", async () => {
  const legacy = { oidc_token_endpoint: null, oidc_client_id: null, oidc_revocation_endpoint: null, user_oidc: { token: TOKEN_EP, client: "01GADGET" } };
  const cases: [string, ReturnType<typeof wired>, RegExp][] = [
    ["no refresh token", wired({ mx_refresh_token: null }), /oauth_error=no_refresh_token/],
    ["no endpoint", wired(legacy, { discoverRevocation: async () => null }), /issuer=https:\/\/auth\.gadget\.test .*oauth_error=no_revocation_endpoint/],
    ["own server refused", wired({}, { ownServer: "gadget.test", revokeLocal: async () => ({ ok: false, error: "http_503", endpoint: "https://mas.gadget.test/oauth2/revoke" }) }), /path=local issuer=https:\/\/mas\.gadget\.test .*oauth_error=http_503/],
  ];
  for (const [name, { deps, calls }, line] of cases) {
    await endReplacedSession(deps, ME, DEVICE, "new-refresh");
    assert.match(calls.logs[0] ?? "", line, name);
    assert.deepEqual(calls.unconfirmed, [ME], name);
    // An outside account never counts toward this install's own alarm.
    assert.deepEqual(calls.sides, [name === "own server refused" ? "local" : "federated"], name);
  }
  const broken = wired({});
  broken.deps.query = async () => { throw new Error("connection reset"); };
  await endReplacedSession(broken.deps, ME, DEVICE, "new-refresh");
  assert.match(broken.calls.logs[0] ?? "", /could not be read/);
  assert.deepEqual(broken.calls.unconfirmed, [ME]);
});

test("re-sign-in: a confirmed revocation, or nothing to end, is neither logged nor counted", async () => {
  for (const [prior, fresh] of [[{}, "new-refresh"], [null, "new-refresh"], [{}, "old-refresh"]] as const) {
    const { deps, calls } = wired(prior);
    await endReplacedSession(deps, ME, DEVICE, fresh);
    assert.deepEqual([calls.logs, calls.unconfirmed], [[], []]);
  }
});

test("unconfirmed re-sign-in revocations reach the production alarms by side: outside accounts alarm on the outside watch; a local burst after the flood still alarms", async () => {
  // The callbacks pass onUnconfirmed: (m, side) => sessionRefusals.record(m, side), and
  // sessionRefusals is createSessionAlarms with these two keys (matrixSessionUpstream.ts).
  let t = 1_800_000_000_000;
  const sent: { key: string; title: string }[] = [];
  const sessionRefusals = createSessionAlarms({
    now: () => t, localKey: "web.matrix-session-refusals", outsideKey: "web.matrix-session-outside-refusals",
    notify: (key, title) => { sent.push({ key, title }); },
  });
  const resignIn = async (matrixId: string, ownServer: string) => {
    const { deps } = wired({ matrix_id: matrixId }, {
      ownServer,
      revokeFederated: async () => ({ ok: false, error: "temporarily_unavailable" }),
      revokeLocal: async () => ({ ok: false, error: "http_503" }),
    });
    deps.onUnconfirmed = (m, side) => sessionRefusals.record(m, side);
    deps.query = priorDbFor(matrixId);
    await endReplacedSession(deps, matrixId, DEVICE, "new-refresh");
    t += 60_000;
  };

  // Outside accounts (this install is site.test): a flood of 20.
  for (let i = 0; i < 20; i++) await resignIn(`@viewer${i}:gadget.test`, "site.test");
  assert.deepEqual(sent, [{ key: "web.matrix-session-outside-refusals", title: "Outside servers refuse sign-ins" }],
    "the outside watch alarmed once, at its 4th, with its own wording");
  assert.deepEqual(sessionRefusals.sizes(), { local: 0, federated: 20 }, "nothing counted on this install's side");

  // Then a real burst on our own server (accounts on gadget.test, this install IS gadget.test).
  for (let i = 0; i < 4; i++) await resignIn(`@local${i}:gadget.test`, "gadget.test");
  assert.deepEqual(sent.map((s) => s.key), ["web.matrix-session-outside-refusals", "web.matrix-session-refusals"],
    "the local burst alarmed after the outside flood");
  assert.equal(sent[1]!.title, "Sign-ins are being refused");
});

test("the route runs the re-sign-in end before it replaces the row, and has no other way to end a session", () => {
  const at = (needle: string) => { const i = src.indexOf(needle); assert.ok(i > 0, `the callback lost ${needle}`); return i; };
  assert.ok(at("checkSignupAllowed(") < at("endReplacedSession("), "a refused signup would still end the old session");
  assert.ok(at("endReplacedSession(") < at("INSERT INTO site.user_sessions"), "the row (and its old refresh token) is replaced before the old chain is ended");
  assert.doesNotMatch(src, /endUpstream\(|endSession\(|\/logout/, "a path that can /logout the device the new session keeps");
  // The own-server callback ends its old chain the same way, and both count what they could not end.
  const mas = stripComments(readFileSync(join(import.meta.dirname, "..", "mas-callback", "route.ts"), "utf8"));
  for (const [name, code] of [["matrix-callback", src], ["mas-callback", mas]] as const) {
    assert.match(code, /endReplacedSession\(\{\s*\.\.\.upstreamDeps\(decToken\), query: \(sql, params\) => pool\.query\(sql, params\), onUnconfirmed: \(m, side\) => sessionRefusals\.record\(m, side\),\s*\}/, name);
  }
  assert.doesNotMatch(mas, /oauthRevoke\(oldRefresh/, "mas-callback's own uncounted prior-chain revoke is back");
  assert.match(mas, /return NextResponse\.redirect\(new URL\(`\/auth\/federated-complete\?token=\$\{pendingToken\}`, BASE_URL\)\);\s*\}\s*$/, "vacuity: the END of mas-callback was read");
});

test("nothing is written before the decisions pass", () => {
  const decided = src.indexOf("if (!outcome.ok)");
  const firstWrite = src.indexOf("pool.query(");
  assert.ok(decided > 0 && firstWrite > decided, "a write precedes the outcome check");
  assert.match(src, /\}\s*$/); // END anchor: the scan reached the end of the file
  assert.ok(src.trimEnd().endsWith(raw.trimEnd().slice(-1)));
});
