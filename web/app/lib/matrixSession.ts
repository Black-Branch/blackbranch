// Server-side Matrix session resolution — the single way API routes obtain a
// user's Matrix access token.
//
// A Matrix session = (Auth.js cookie, site.user_sessions row, device ID, token
// chain). One row per browser device; concurrent browsers never share or
// clobber each other's identity. Tokens are refreshed here (deduped per
// session) and re-encrypted at rest.
//
// The cookie authorizes only while its row lives (siteSession.ts, checked by every
// auth()): a cookie whose row is gone — or one from before per-session rows, with
// no session id at all — reaches here as `authState: "revoked"` and is answered as
// a revoked session, so the browser wipes its crypto stores and signs out exactly
// as it does when the row disappears under a live cookie.

import { auth } from "@/auth";
import pool from "@/lib/db";
import { encToken, decToken } from "@/app/lib/tokenCrypto";
import { homeserverFetch } from "@/app/lib/homeserverFetch";
import { readJsonCapped, MATRIX_JSON_MAX_BYTES, OAUTH_REPLY_MAX_BYTES } from "@/app/lib/boundedBody";
import { matrixBaseUrl } from "@/app/lib/matrixConfig";
import { authMetadataOrNull } from "@/app/lib/matrixAuthMetadata";
import { oauthTokenRequest } from "@/app/lib/matrixOAuthClient";
import { policyGatedSession } from "@/app/lib/federatedSignInSwitch";
import { refreshPathFor } from "@/app/lib/matrixRefreshPath";

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

// Refresh-token grant permanently rejected — the session was revoked (e.g. from
// the MAS account page). The row is already deleted when this is thrown.
export class RevokedSessionError extends Error {
  constructor() { super("SESSION_REVOKED"); }
}

type SessionRow = {
  session_id: string;
  matrix_id: string;
  mx_device_id: string;
  mx_access_token: string | null;
  mx_refresh_token: string | null;
  mx_token_expires: string | number | null;
  homeserver: string | null;
  oidc_token_endpoint: string | null;
  oidc_client_id: string | null;
};

type FreshTokens = { access_token: string; refresh_token?: string; expires_in?: number };

// Our own server's refresh, at the DISCOVERED token endpoint. If discovery fails,
// oauthTokenRequest throws a plain (transient) error — NEVER RevokedSessionError — so an
// auth-server outage leaves every session row and every browser crypto store alone. Only the
// token endpoint's own `invalid_grant` answer means revoked.
async function localRefresh(refreshToken: string): Promise<FreshTokens> {
  const res = await oauthTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }));
  if (!res.ok) {
    const body = ((await readJsonCapped(res, MATRIX_JSON_MAX_BYTES)) ?? {}) as { error?: string };
    if (body.error === "invalid_grant" || body.error === "invalid_token") throw new RevokedSessionError();
    throw new Error(`refresh failed: ${res.status}`);
  }
  const fresh = (await readJsonCapped(res, MATRIX_JSON_MAX_BYTES)) as FreshTokens | null;
  if (!fresh) throw new Error("refresh failed: unreadable token response");
  return fresh;
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
  if (!res.ok) {
    const body = ((await readJsonCapped(res, OAUTH_REPLY_MAX_BYTES)) ?? {}) as { error?: string };
    if (body.error === "invalid_grant" || body.error === "invalid_token") throw new RevokedSessionError();
    throw new Error(`federated refresh failed: ${res.status}`);
  }
  // A plain (transient) error when unreadable — never RevokedSessionError.
  const fresh = (await readJsonCapped(res, OAUTH_REPLY_MAX_BYTES)) as FreshTokens | null;
  if (!fresh) throw new Error("federated refresh failed: unreadable token response");
  return fresh;
}

// Concurrent calls for the same session share one refresh instead of racing
// MAS's refresh-token rotation (rotation invalidates the old refresh token, so
// a parallel second refresh would 400 and look like a revocation).
const inFlight = new Map<string, Promise<MatrixSession>>();

async function loadRow(matrixId: string, sessionId: string): Promise<SessionRow | null> {
  const { rows } = await pool.query(
    `SELECT s.session_id, s.matrix_id, s.mx_device_id, s.mx_access_token,
            s.mx_refresh_token, s.mx_token_expires,
            u.homeserver, u.oidc_token_endpoint, u.oidc_client_id
     FROM site.user_sessions s JOIN site.users u USING (matrix_id)
     WHERE s.session_id = $1 AND s.matrix_id = $2`,
    [sessionId, matrixId]
  );
  return rows[0] ?? null;
}

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
  const row = await loadRow(matrixId, sessionId);
  if (!row) throw new RevokedSessionError();

  const homeserver = row.homeserver ?? matrixBaseUrl();
  const accountUrl = await accountUrlFor(row);
  const base = {
    sessionId,
    matrixId,
    deviceId: row.mx_device_id,
    homeserver,
    accountUrl,
  };

  const storedAccess = decToken(row.mx_access_token);
  const expires = Number(row.mx_token_expires ?? 0);
  if (storedAccess && expires && Date.now() < expires - 30_000) {
    // touch last_seen opportunistically; not worth blocking the response on
    pool.query(`UPDATE site.user_sessions SET last_seen = now() WHERE session_id = $1`, [row.session_id]).catch(() => {});
    return { ...base, accessToken: storedAccess, expiresAt: expires };
  }

  const storedRefresh = decToken(row.mx_refresh_token);
  if (!storedRefresh) throw new RevokedSessionError();

  try {
    // Chosen by the account's server, not the stored columns (matrixRefreshPath.ts says why).
    const path = refreshPathFor(row);
    const fresh = path.kind === "federated"
      ? await federatedRefresh(storedRefresh, path.tokenEndpoint, path.clientId)
      : await localRefresh(storedRefresh);
    const expiresAt = Date.now() + (fresh.expires_in ?? 3600) * 1000;
    await pool.query(
      `UPDATE site.user_sessions
       SET mx_access_token = $1, mx_refresh_token = $2, mx_token_expires = $3, last_seen = now()
       WHERE session_id = $4`,
      [encToken(fresh.access_token), encToken(fresh.refresh_token ?? storedRefresh), expiresAt, row.session_id]
    );
    return { ...base, accessToken: fresh.access_token, expiresAt };
  } catch (e) {
    if (e instanceof RevokedSessionError) {
      // Session revoked upstream (MAS account page, admin, etc.) — remove the
      // dead row so the client gets a clean "revoked" and signs out fully.
      await pool.query(`DELETE FROM site.user_sessions WHERE session_id = $1`, [row.session_id]).catch(() => {});
      throw e;
    }
    // Transient failure — another server instance may have rotated the token.
    const retry = await loadRow(matrixId, sessionId);
    const retryAccess = decToken(retry?.mx_access_token);
    const retryExpires = Number(retry?.mx_token_expires ?? 0);
    if (retry && retryAccess && retryExpires && Date.now() < retryExpires - 30_000) {
      return { ...base, deviceId: retry.mx_device_id, accessToken: retryAccess, expiresAt: retryExpires };
    }
    throw e;
  }
}

/**
 * Resolve the caller's Matrix session, refreshing the access token if needed.
 *
 * @returns null when unauthenticated (no Auth.js session).
 * @throws RevokedSessionError when the Matrix session no longer exists or was
 *         revoked — callers should return 401 with reason "revoked".
 * @throws Error on transient refresh/DB failures.
 */
export async function getMatrixSession(): Promise<MatrixSession | null> {
  const session = await auth();
  const matrixId = session?.user?.id;
  const sessionId = session?.sessionId;
  if (!matrixId || !sessionId) {
    if (session?.authState === "revoked") throw new RevokedSessionError();
    if (session?.authState === "unavailable") throw new Error("site session check unavailable");
    return null;
  }

  // The federated sign-in policy (federatedSignInSwitch.ts), asked before the load and again after
  // it: a session from a server the policy refuses is signed out — not revoked, so its row and the
  // browser's crypto store are kept — even when a refresh was already in flight.
  return policyGatedSession(matrixId, () => {
    const existing = inFlight.get(sessionId);
    if (existing) return existing;
    const p = resolve(matrixId, sessionId).finally(() => { inFlight.delete(sessionId); });
    inFlight.set(sessionId, p);
    return p;
  });
}

/** Delete a session row and best-effort revoke its tokens at the homeserver. */
export async function destroyMatrixSession(): Promise<void> {
  const session = await auth();
  const matrixId = session?.user?.id;
  const sessionId = session?.sessionId;
  if (!matrixId || !sessionId) return;

  const row = await loadRow(matrixId, sessionId).catch(() => null);
  if (!row) return;

  const token = decToken(row.mx_access_token);
  const homeserver = row.homeserver ?? matrixBaseUrl();
  if (token) {
    // Under MAS this revokes the OAuth session, which also deletes the Synapse
    // device — keeping device lists truthful everywhere.
    await homeserverFetch(`${homeserver}/_matrix/client/v3/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  await pool.query(`DELETE FROM site.user_sessions WHERE session_id = $1`, [row.session_id]).catch(() => {});
}
