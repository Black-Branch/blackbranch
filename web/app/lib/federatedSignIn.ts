// Federated sign-in — an account on ANOTHER Matrix server signing in here. SERVER ONLY.
//
// Three routes share this file: matrix-discover (find the outside server's sign-in endpoints),
// matrix-initiate (register this site with it, set the state cookie, hand the browser the
// authorize URL) and matrix-callback (the code comes back: exchange it, prove who it is, bind it).
// The logic lives here, with the fetch injected, so it runs under `node --test`
// (federatedSignIn.test.ts) — the routes keep only their request/response plumbing and the writes.
//
// Everything an outside server says is untrusted:
//  - The STATE COOKIE carries the token endpoint and homeserver the callback will talk to. It is
//    HMAC-signed with an issued-at, and the callback checks the signature (constant time) and the
//    age BEFORE it reads any field and before any outbound request — an unsigned cookie was a way
//    to make this site POST to, and wait on, any server an attacker named, with no rate limit.
//  - Every ENDPOINT is validated by parseAuthMetadata (https, on the issuer's own origin) whichever
//    discovery document it came from — the older openid-configuration fallback included. An
//    unvalidated `javascript:` authorize URL ran script on our origin when the sign-in page
//    navigated to it.
//  - The TOKEN ENDPOINT stored for refreshes must sit on the origin of the issuer re-discovered
//    from the homeserver that vouched for the account — not just wherever the browser said.
//  - Every read is capped and every request has a deadline (ssrf.ts, boundedBody.ts).

import { createHmac, timingSafeEqual } from "node:crypto";
import { readBodyPrefix, readJsonCapped, ERROR_LOG_MAX_BYTES, MATRIX_JSON_MAX_BYTES, OAUTH_REPLY_MAX_BYTES } from "./boundedBody.ts";
import { parseAuthMetadata, type AuthMetadata } from "./matrixAuthMetadata.ts";
import { sameOrigin } from "./homeserverTrust.ts";
import { deviceMismatch } from "./signinDevice.ts";
import { normalizeServerName, FEDERATED_SIGNIN_REFUSED } from "./federatedSignInSwitch.ts";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ─── The state cookie ─────────────────────────────────────────────────────────

export const FED_STATE_COOKIE = "mx_fed_state";
/** The cookie's life, and the most the callback accepts for its issued-at — the same 5 minutes. */
export const FED_STATE_TTL_S = 300;
/** Clock skew tolerated for an issued-at slightly in the future (one process signs and verifies,
 *  so this only covers a clock step between the two requests). */
const FUTURE_SKEW_MS = 30_000;

export type FedState = {
  state: string;
  codeVerifier: string;
  tokenEndpoint: string;
  homeserver: string;
  clientId: string;
  deviceId: string;
  /** The Matrix server name the visitor asked to sign in with (initiate checked it against the
   *  sign-in policy). The account the callback authenticates must be on exactly this server. */
  serverName: string;
};

/** The secret the state cookie is signed with: the site's existing Auth.js secret (no new key to
 *  provision). null when the process has none — sign-in is then refused, never left unsigned. */
export function fedStateSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.AUTH_SECRET || env.AUTH_SECRET_1 || null;
}

/** A key DERIVED from the session secret for this one purpose, so the raw secret never signs a
 *  value an outsider can read alongside its MAC. */
function stateKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("federated-sign-in state cookie v1").digest();
}

function mac(secret: string, issuedAt: string, payload: string): Buffer {
  return createHmac("sha256", stateKey(secret)).update(`${issuedAt}.${payload}`).digest();
}

/** The cookie value: `v1.<issuedAt ms>.<payload b64url>.<HMAC-SHA256(issuedAt.payload) b64url>`. */
export function signFedState(data: FedState, secret: string, now: number = Date.now()): string {
  const issuedAt = String(Math.floor(now));
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `v1.${issuedAt}.${payload}.${mac(secret, issuedAt, payload).toString("base64url")}`;
}

export type FedStateCheck = { ok: true; data: FedState } | { ok: false; reason: "invalid" | "expired" };

/**
 * Verify a state cookie. The MAC is checked first (constant time), then the issued-at — and only
 * then is the payload decoded. Nothing from an unverified or expired cookie is ever read.
 * @test-only exported so federatedSignIn.test.ts can round-trip a cookie; the product reads it
 * only through completeFederatedCallback.
 */
export function verifyFedState(raw: string | undefined | null, secret: string, now: number = Date.now()): FedStateCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return { ok: false, reason: "invalid" };
  const [, issuedAt, payload, sig] = parts as [string, string, string, string];
  const expected = mac(secret, issuedAt, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "invalid" };
  if (!/^\d{1,16}$/.test(issuedAt)) return { ok: false, reason: "invalid" };
  const age = now - Number(issuedAt);
  if (age > FED_STATE_TTL_S * 1000 || age < -FUTURE_SKEW_MS) return { ok: false, reason: "expired" };
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const d = data as Record<string, unknown> | null;
  const keys = ["state", "codeVerifier", "tokenEndpoint", "homeserver", "clientId", "deviceId", "serverName"] as const;
  if (!d || typeof d !== "object" || keys.some((k) => typeof d[k] !== "string" || d[k] === "")) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, data: Object.fromEntries(keys.map((k) => [k, d[k]])) as FedState };
}

// ─── Initiate: the endpoints the browser sends back ───────────────────────────

/**
 * Why these endpoints must be refused, or null. They come from the browser (it read them from
 * matrix-discover), so they are re-checked here: each must be an https URL with no credentials,
 * and all three must share one origin — the issuer's, as parseAuthMetadata required at discovery.
 * The authorize URL is where the browser is sent next; a `javascript:` one ran on our origin.
 */
export function initiateEndpointsProblem(e: { authorizationEndpoint: unknown; tokenEndpoint: unknown; registrationEndpoint: unknown }): string | null {
  const urls: URL[] = [];
  for (const [field, raw] of Object.entries(e)) {
    if (typeof raw !== "string" || raw === "") return `missing ${field}`;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return `unparseable ${field}`;
    }
    if (u.protocol !== "https:" || u.username || u.password) return `${field} is not a plain https URL`;
    urls.push(u);
  }
  if (urls.some((u) => u.origin !== urls[0]?.origin)) return "the endpoints are on different origins";
  return null;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

// An auth_metadata / openid-configuration document lists endpoints and supported values; real ones
// run a few KB. Larger than the other control-plane reads because providers pad them.
const AUTH_DOC_MAX_BYTES = 256 * 1024;
const DISCOVERY_TIMEOUT_MS = 5_000;

export type IssuerDiscovery =
  | { ok: true; metadata: AuthMetadata }
  | { ok: false; error: "no_oidc" | "oidc_discovery_failed" | "oidc_discovery_unreachable" | "oidc_invalid" };

/**
 * The sign-in endpoints of `homeserver`, VALIDATED: its own auth_metadata first; a server without
 * that route falls back to the issuer its `.well-known` names (`wellKnown`, already read) and that
 * issuer's openid-configuration — which goes through the SAME parser (https, on the issuer's
 * origin), and must name an issuer on the origin the well-known gave.
 */
export async function discoverIssuer(homeserver: string, wellKnown: Record<string, unknown> | null, fetch: Fetcher): Promise<IssuerDiscovery> {
  try {
    const am = await fetch(`${homeserver}/_matrix/client/v1/auth_metadata`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (am.ok) return { ok: true, metadata: parseAuthMetadata(await readJsonCapped(am, AUTH_DOC_MAX_BYTES), null) };
    void am.body?.cancel().catch(() => {});
  } catch {
    // Unreachable, or a document that fails validation — try the older discovery instead.
  }

  const auth = (wellKnown?.["m.authentication"] ?? wellKnown?.["org.matrix.msc2965.authentication"]) as { issuer?: unknown } | undefined;
  if (typeof auth?.issuer !== "string" || !auth.issuer) return { ok: false, error: "no_oidc" };
  const issuer = auth.issuer.replace(/\/$/, "");

  let doc: unknown;
  try {
    const oc = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!oc.ok) {
      void oc.body?.cancel().catch(() => {});
      return { ok: false, error: "oidc_discovery_failed" };
    }
    doc = await readJsonCapped(oc, AUTH_DOC_MAX_BYTES);
  } catch {
    return { ok: false, error: "oidc_discovery_unreachable" };
  }
  if (doc === null) return { ok: false, error: "oidc_discovery_unreachable" };
  try {
    const metadata = parseAuthMetadata(doc, null);
    if (!sameOrigin(metadata.issuer, issuer)) return { ok: false, error: "oidc_invalid" };
    return { ok: true, metadata };
  } catch {
    return { ok: false, error: "oidc_invalid" };
  }
}

/**
 * A Matrix server_name's homeserver base_url the way a client resolves it: `.well-known/matrix/client`
 * delegation, falling back to the bare origin when the server publishes none (per the
 * client-server spec). null when the domain is unreachable, SSRF-blocked or answers garbage, so the
 * caller fails CLOSED. Also returns the well-known document for issuer discovery.
 */
async function resolveHomeserverFor(serverName: string, fetch: Fetcher): Promise<{ homeserver: string; wellKnown: Record<string, unknown> | null } | null> {
  const bare = `https://${serverName}`;
  try {
    const wk = await fetch(`${bare}/.well-known/matrix/client`, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
    if (!wk.ok) {
      void wk.body?.cancel().catch(() => {});
      return { homeserver: bare, wellKnown: null };
    }
    const json = await readJsonCapped(wk, MATRIX_JSON_MAX_BYTES);
    if (json === null || typeof json !== "object") return null;
    const doc = json as Record<string, unknown>;
    const base = (doc["m.homeserver"] as { base_url?: unknown } | undefined)?.base_url;
    return { homeserver: typeof base === "string" && base ? base.replace(/\/$/, "") : bare, wellKnown: doc };
  } catch {
    return null;
  }
}

// ─── The callback ─────────────────────────────────────────────────────────────

export type CallbackTokens = { access_token: string; refresh_token?: string; expires_in?: number };

export type CallbackOutcome =
  | {
      ok: true;
      matrixId: string;
      deviceId: string;
      homeserver: string;
      tokenEndpoint: string;
      clientId: string;
      tokens: CallbackTokens;
    }
  /** `error` is the sign-in page's `?error=` code. */
  | { ok: false; error: string };

export type CallbackDeps = {
  /** The SSRF-guarded transport (safeFetch) in production; tests count calls through a stub. */
  fetch: Fetcher;
  secret: string | null;
  now: () => number;
  redirectUri: string;
  log: Pick<Console, "error">;
  /** The sign-in policy as it is NOW (federatedSignInSwitch.ts federatedServerAllowed) — asked
   *  again here, so a login that started before the policy tightened is refused at the end. */
  serverAllowed: (serverName: string) => boolean;
};

/**
 * Everything the callback decides before it writes anything: the state cookie, the code exchange,
 * whoami, the device binding, the homeserver that vouches for the account, and the issuer that
 * owns the token endpoint. The route performs the writes only on `ok: true`.
 */
export async function completeFederatedCallback(
  input: { code: string; state: string; cookie: string | undefined },
  deps: CallbackDeps,
): Promise<CallbackOutcome> {
  if (!input.cookie) return { ok: false, error: "session_expired" };
  if (!deps.secret) {
    deps.log.error("[matrix-callback] no AUTH_SECRET — federated sign-in refused (the state cookie cannot be verified)");
    return { ok: false, error: "unavailable" };
  }
  // Signature and age FIRST — no field of the cookie is read, and nothing is fetched, before both pass.
  const checked = verifyFedState(input.cookie, deps.secret, deps.now());
  if (!checked.ok) return { ok: false, error: checked.reason === "expired" ? "session_expired" : "invalid_state" };
  const st = checked.data;
  if (st.state !== input.state) return { ok: false, error: "state_mismatch" };

  // Exchange the authorization code (public client — no client_secret). The transport re-validates
  // the endpoint against the SSRF filter and carries the default deadline over the body read.
  let tokenRes: Response;
  try {
    tokenRes = await deps.fetch(st.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: deps.redirectUri,
        client_id: st.clientId,
        code_verifier: st.codeVerifier,
      }),
    });
  } catch {
    return { ok: false, error: "token_exchange_failed" };
  }
  if (!tokenRes.ok) {
    deps.log.error("[matrix-callback] token exchange failed:", tokenRes.status, await readBodyPrefix(tokenRes, ERROR_LOG_MAX_BYTES));
    return { ok: false, error: "token_exchange_failed" };
  }
  const tokens = (await readJsonCapped(tokenRes, OAUTH_REPLY_MAX_BYTES).catch(() => null)) as Partial<CallbackTokens> | null;
  if (typeof tokens?.access_token !== "string" || !tokens.access_token) return { ok: false, error: "token_exchange_failed" };

  // Who is this token? Answered by the homeserver the cookie names — bound below.
  const whoami = (await deps.fetch(`${st.homeserver}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then((r) => (r.ok ? readJsonCapped(r, OAUTH_REPLY_MAX_BYTES) : null)).catch(() => null)) as { user_id?: unknown; device_id?: unknown } | null;
  if (typeof whoami?.user_id !== "string" || !whoami.user_id) return { ok: false, error: "whoami_failed" };
  const matrixId = whoami.user_id;

  // The token must be bound to the device we asked for (signinDevice.ts) — before anything is
  // written. No revoke: the state records no revocation endpoint, so the unused token is dropped.
  const refusal = deviceMismatch(st.deviceId, whoami);
  if (refusal) {
    deps.log.error("[matrix-callback] REFUSED sign-in for %s: %s", matrixId, refusal);
    return { ok: false, error: "device_mismatch" };
  }

  // SECURITY — bind the asserted MXID to the homeserver that actually vouched for it. The cookie's
  // homeserver came from the browser, so whoami above was answered by a host the caller chose;
  // without this, anyone could stand up a server answering {"user_id":"@admin:<our server>"}.
  // Re-derive the homeserver from the MXID's OWN domain and require it to be the one the token
  // came from: an identity can then only be asserted by the domain that genuinely hosts it.
  const serverName = matrixId.match(/^@[^:]+:(.+)$/)?.[1];
  if (!serverName) return { ok: false, error: "invalid_mxid" };

  // The sign-in policy, on the AUTHENTICATED account's server: it must be the server the login
  // started with (a login cannot begin on an allowed server and finish as an account elsewhere),
  // and the policy as it stands now must still admit it (a login in flight when it tightened).
  if (normalizeServerName(serverName) !== normalizeServerName(st.serverName)) {
    deps.log.error("[matrix-callback] REFUSED sign-in for %s: the login started for %s", matrixId, st.serverName);
    return { ok: false, error: "server_mismatch" };
  }
  if (!deps.serverAllowed(serverName)) {
    deps.log.error("[matrix-callback] REFUSED sign-in for %s: sign-in from that server is not enabled", matrixId);
    return { ok: false, error: FEDERATED_SIGNIN_REFUSED };
  }
  const vouched = await resolveHomeserverFor(serverName, deps.fetch);
  if (!vouched || !sameOrigin(vouched.homeserver, st.homeserver)) {
    deps.log.error(
      "[matrix-callback] REJECTED identity assertion — %s claims to be hosted at %s, but %s resolves to %s",
      matrixId, st.homeserver, serverName, vouched?.homeserver ?? "(unresolvable)",
    );
    return { ok: false, error: "homeserver_mismatch" };
  }

  // The token endpoint is stored and POSTed to on every refresh — so it must belong to the issuer
  // that the VOUCHED homeserver names today, not merely to whatever the browser sent.
  const issuer = await discoverIssuer(vouched.homeserver, vouched.wellKnown, deps.fetch);
  if (!issuer.ok || !sameOrigin(st.tokenEndpoint, issuer.metadata.issuer)) {
    deps.log.error(
      "[matrix-callback] REJECTED token endpoint for %s — not on the issuer %s names (%s)",
      matrixId, vouched.homeserver, issuer.ok ? "different origin" : issuer.error,
    );
    return { ok: false, error: "issuer_mismatch" };
  }

  return {
    ok: true,
    matrixId,
    deviceId: st.deviceId,
    homeserver: st.homeserver,
    tokenEndpoint: st.tokenEndpoint,
    clientId: st.clientId,
    tokens: {
      access_token: tokens.access_token,
      ...(typeof tokens.refresh_token === "string" ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.expires_in === "number" ? { expires_in: tokens.expires_in } : {}),
    },
  };
}
