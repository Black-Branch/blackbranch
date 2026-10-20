// This site's confidential OAuth client at the homeserver's issuer — the ONE place the sign-in
// flow, the token refresh and revocation build their requests. SERVER ONLY.
//
// Endpoints come from auth_metadata discovery (matrixAuthMetadata.ts), the client id from the
// install-tier `matrix.oauth.clientId` (env MATRIX_OAUTH_CLIENT_ID, alias MAS_CLIENT_ID), the
// secret from the secret-tier `matrix.oauth.clientSecret` (env MATRIX_OAUTH_CLIENT_SECRET, alias
// MAS_CLIENT_SECRET). No caller restates the token URL or the Basic header on its own.
//
// Every failure here is TRANSIENT (a plain Error / AuthMetadataError). Only the caller that
// reads an `invalid_grant` answer from the token endpoint itself may conclude a session was
// revoked — see matrixSession.ts.

import { authMetadata, authMetadataOrNull, clientBasicAuth } from "./matrixAuthMetadata.ts";
import { matrixOAuthClientId } from "./matrixConfig.ts";
import { instanceString } from "./instanceConfigServer.ts";

function clientAuth(): string {
  const id = matrixOAuthClientId();
  const secret = instanceString("matrix.oauth.clientSecret");
  if (!id || !secret) {
    throw new Error("the Matrix sign-in client is not configured (matrix.oauth.clientId / matrix.oauth.clientSecret)");
  }
  return clientBasicAuth(id, secret);
}

/** POST to the discovered token endpoint as this site's client (client_secret_basic). */
export async function oauthTokenRequest(params: URLSearchParams, signal?: AbortSignal): Promise<Response> {
  const md = await authMetadata();
  return fetch(md.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: clientAuth() },
    body: params,
    ...(signal ? { signal } : {}),
  });
}

/** Best-effort revocation at the discovered revocation endpoint. Never throws; a server that
 *  publishes no revocation endpoint is logged and skipped. */
export async function oauthRevoke(token: string, hint: "access_token" | "refresh_token"): Promise<void> {
  const md = await authMetadataOrNull();
  if (!md?.revocationEndpoint) {
    console.warn(`[matrix-auth] revoke skipped (${md ? "no revocation_endpoint published" : "auth metadata unavailable"})`);
    return;
  }
  let auth: string;
  try {
    auth = clientAuth();
  } catch (e) {
    console.warn(`[matrix-auth] revoke skipped: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await fetch(md.revocationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: auth },
    body: new URLSearchParams({ token, token_type_hint: hint }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
