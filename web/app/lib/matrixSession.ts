// Server-side Matrix session resolution — the single way API routes obtain a
// user's Matrix access token.
//
// A Matrix session = (Auth.js cookie, site.user_sessions row, device ID, token
// chain). One row per browser device; concurrent browsers never share or
// clobber each other's identity. Tokens are refreshed here (deduped per
// session) and re-encrypted at rest.
//
// The decisions live in matrixSessionCore.ts (executed by its tests); this file wires them to
// @/auth, the pool and the endpoints. The cookie authorizes only while its row lives
// (siteSession.ts): a cookie whose row is gone reaches here as `authState: "revoked"` and is
// answered as SIGNED OUT (the browser keeps its crypto store — whatever removed the row decided
// about the device); a deleted account's cookie (`"deleted"`) is answered as revoked.

import { auth } from "@/auth";
import pool from "@/lib/db";
import { encToken, decToken } from "@/app/lib/tokenCrypto";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { MATRIX_JSON_MAX_BYTES, OAUTH_REPLY_MAX_BYTES } from "@/app/lib/boundedBody";
import { masAdmin, masDeviceStatus } from "@/app/lib/matrixMasAdmin";
import { matrixBaseUrl, matrixServerName } from "@/app/lib/matrixConfig";
import { authMetadataOrNull } from "@/app/lib/matrixAuthMetadata";
import { oauthTokenRequest } from "@/app/lib/matrixOAuthClient";
import { policyGatedSession, serverNameOf, normalizeServerName } from "@/app/lib/federatedSignInSwitch";
import { refreshPathFor } from "@/app/lib/matrixRefreshPath";
import {
  loadSessionRow, endSession, resolveTokens, readRefreshAnswer, createSessionGetter, RevokedSessionError, SignedOutSessionError,
  type Query, type SessionRow, type ResolveDeps, type DeviceStatus, type FreshTokens,
} from "@/app/lib/matrixSessionCore";
import { upstreamDeps, sessionRefusals } from "@/app/lib/matrixSessionUpstream";

const query: Query = (sql, params) => pool.query(sql, params);

// A NULL site.users.homeserver means "ours" — and "ours" is the configured matrix.baseUrl, not the
// sign-in issuer's origin (the two can differ).

export type MatrixSession = {
  sessionId: string;
  matrixId: string;
  deviceId: string;
  accessToken: string;
  expiresAt: number;
  homeserver: string;
  /** The account page for this session's server, or null when it cannot be named right now. */
  accountUrl: string | null;
};

export { RevokedSessionError, SignedOutSessionError };

// Our own server's refresh, at the DISCOVERED token endpoint. If discovery fails,
// oauthTokenRequest throws a plain (transient) error — never a refusal — so an auth-server outage
// leaves every session row and every browser crypto store alone. Only the token endpoint's own
// answer is a refusal (readRefreshAnswer), and even that is not a revoke until MAS confirms it.
async function localRefresh(refreshToken: string): Promise<FreshTokens> {
  const res = await oauthTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
  return readRefreshAnswer(res, MATRIX_JSON_MAX_BYTES);
}

async function federatedRefresh(refreshToken: string, tokenEndpoint: string, clientId: string): Promise<FreshTokens> {
  // tokenEndpoint is a stored, user-influenced federation value → SSRF-guarded transport, with
  // homeserverFetch's default deadline over the whole exchange INCLUDING the body read (a server
  // trickling its answer would otherwise hold this — and the request waiting on it — open
  // indefinitely). The endpoint was bound to its homeserver's issuer at sign-in (federatedSignIn.ts).
  const res = await homeserverFetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  return readRefreshAnswer(res, OAUTH_REPLY_MAX_BYTES);
}

/** After OUR account server refused a refresh: does it still list the device? (matrixMasAdmin.ts)
 *  Only an id on this install's server is looked up; any other is "unknown" (the store is kept). */
function deviceStatus(row: SessionRow): Promise<DeviceStatus> {
  if (serverNameOf(row.matrix_id) !== normalizeServerName(matrixServerName())) return Promise.resolve("unknown");
  const username = row.matrix_id.slice(1, row.matrix_id.indexOf(":"));
  return masDeviceStatus(masAdmin(), username, row.mx_device_id);
}

/** One ops push through stream-api's relay (its one rate limiter per key). Never throws. */
function opsNotify(key: string, title: string, message: string): void {
  void import("@/app/lib/streamApi").then(({ streamApiFetch }) =>
    streamApiFetch("/ops/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, title, message }),
    })).catch(() => undefined);
}

function alarm(message: string): void {
  console.error(`[matrix-session] ${message}`);
  opsNotify("web.matrix-session-key", "Matrix sessions cannot be refreshed", message);
}


const resolveDeps: ResolveDeps = {
  query,
  dec: decToken,
  enc: encToken,
  now: () => Date.now(),
  get ownServer() { return matrixServerName(); },
  // Chosen by the account's server, not the stored columns (matrixRefreshPath.ts says why).
  refresh: (path, token) => (path.kind === "federated" ? federatedRefresh(token, path.tokenEndpoint, path.clientId) : localRefresh(token)),
  deviceStatus,
  alarm,
  log: (line) => console.warn(line),
  // Refusals that cluster push one alarm — the 10-21 pattern, which only a viewer's report
  // surfaced (matrixSessionWatch.ts; the one instance lives in matrixSessionUpstream.ts).
  onRefusal: (matrixId, side) => sessionRefusals.record(matrixId, side),
};


async function accountUrlFor(row: SessionRow): Promise<string | null> {
  const path = refreshPathFor(row);
  if (path.kind === "federated") {
    // An OUTSIDE server's account page, guessed from its stored token endpoint — not ours to
    // discover here (out of M1's scope; the federated row stores no metadata). An own-server
    // account always gets our MAS metadata, whatever stale columns its row carries.
    return `${path.tokenEndpoint.replace(/\/oauth2\/token$/, "")}/account`;
  }
  return (await authMetadataOrNull())?.accountManagementUri ?? null;
}

async function resolve(matrixId: string, sessionId: string): Promise<MatrixSession> {
  const { row, accessToken, expiresAt } = await resolveTokens(resolveDeps, matrixId, sessionId);
  return {
    sessionId,
    matrixId,
    deviceId: row.mx_device_id,
    homeserver: row.homeserver ?? matrixBaseUrl(),
    accountUrl: await accountUrlFor(row),
    accessToken,
    expiresAt,
  };
}

/**
 * The 401 for a session that has ended, or null for anything else. `revoked` (confirmed: the
 * browser wipes this device's crypto store) carries the user and device so the wipe is scoped;
 * `signed_out` keeps the store and device id.
 */
export function endedSessionResponse(e: unknown): Response | null {
  if (e instanceof RevokedSessionError) {
    return Response.json({ error: "session_expired", reason: "revoked", matrixId: e.matrixId, deviceId: e.deviceId }, { status: 401 });
  }
  if (e instanceof SignedOutSessionError) return Response.json({ error: "session_expired", reason: "signed_out" }, { status: 401 });
  return null;
}

/**
 * Resolve the caller's Matrix session, refreshing the access token if needed.
 *
 * @returns null when unauthenticated (no Auth.js session).
 * @throws RevokedSessionError / SignedOutSessionError when the session has ended — callers answer
 *         with endedSessionResponse.
 * @throws Error on transient refresh/DB failures.
 */
export const getMatrixSession: () => Promise<MatrixSession | null> = createSessionGetter<MatrixSession>({
  auth: () => auth(),
  resolve,
  // The federated sign-in policy (federatedSignInSwitch.ts), asked before the load and again after
  // it: a session from a server the policy refuses is signed out — not revoked, so its row and the
  // browser's crypto store are kept — even when a refresh was already in flight.
  gate: (matrixId, load) => policyGatedSession(matrixId, load),
  log: (line) => console.warn(line),
});

/** Sign-out: end this session at its account server (refresh-token revocation), then delete the
 *  row (matrixSessionCore.ts endSession). */
export async function destroyMatrixSession(): Promise<void> {
  const session = await auth();
  const matrixId = session?.user?.id;
  const sessionId = session?.sessionId;
  if (!matrixId || !sessionId) return;

  const row = await loadSessionRow(query, matrixId, sessionId).catch(() => null);
  if (!row) return;
  await endSession({ ...upstreamDeps(decToken), query }, row);
}
