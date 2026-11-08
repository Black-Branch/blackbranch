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
import { readJsonCapped, OAUTH_REPLY_MAX_BYTES } from "./boundedBody.ts";
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

/** A revocation's answer: confirmed, or why not — the server's OAuth `error`/`error_description`
 *  (RFC 6749 §5.2), `http_<status>` without one, a network code, or a local reason
 *  (`no_revocation_endpoint`, `auth_metadata_unavailable`, `no_client`). `endpoint` = where it went. */
export type RevokeOutcome = { ok: true; endpoint?: string } | { ok: false; error: string; description?: string; endpoint?: string };

/** One RFC 7009 revocation request, with the reason when it is not confirmed. ok only on 2xx
 *  (§2.2: a token that is already invalid answers 200 too). `authorization` null = a public
 *  client, named by `extra`'s client_id. Never throws. */
export async function revokeAtOutcome(
  endpoint: string,
  authorization: string | null,
  token: string,
  hint: "access_token" | "refresh_token",
  extra: Record<string, string> = {},
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<RevokeOutcome> {
  try {
    const r = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(authorization ? { Authorization: authorization } : {}) },
      body: new URLSearchParams({ token, token_type_hint: hint, ...extra }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      await r.body?.cancel().catch(() => {});
      return { ok: true, endpoint };
    }
    const body = ((await readJsonCapped(r, OAUTH_REPLY_MAX_BYTES).catch(() => null)) ?? {}) as { error?: unknown; error_description?: unknown };
    return {
      ok: false, endpoint,
      error: typeof body.error === "string" && body.error ? body.error : `http_${r.status}`,
      ...(typeof body.error_description === "string" ? { description: body.error_description } : {}),
    };
  } catch (e) {
    const code = (e as { cause?: { code?: unknown }; name?: unknown } | null)?.cause?.code ?? (e as { name?: unknown } | null)?.name;
    return { ok: false, endpoint, error: typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "network" };
  }
}

/** revokeAtOutcome, answered as confirmed / not. Never throws.
 *  @test-only the boolean form the session tests drive against stubs and the throwaway MAS; the
 *  product calls revokeAtOutcome (the journal needs the reason). */
export async function revokeAt(
  endpoint: string,
  authorization: string | null,
  token: string,
  hint: "access_token" | "refresh_token",
  extra: Record<string, string> = {},
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  return (await revokeAtOutcome(endpoint, authorization, token, hint, extra, fetchFn)).ok;
}

/** Revocation at the discovered revocation endpoint, as this site's client, with the reason when
 *  it is not confirmed. Never throws. */
export async function oauthRevokeOutcome(token: string, hint: "access_token" | "refresh_token"): Promise<RevokeOutcome> {
  const md = await authMetadataOrNull();
  if (!md?.revocationEndpoint) {
    console.warn(`[matrix-auth] revoke skipped (${md ? "no revocation_endpoint published" : "auth metadata unavailable"})`);
    return { ok: false, error: md ? "no_revocation_endpoint" : "auth_metadata_unavailable" };
  }
  let auth: string;
  try {
    auth = clientAuth();
  } catch (e) {
    console.warn(`[matrix-auth] revoke skipped: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: "no_client", endpoint: md.revocationEndpoint };
  }
  return revokeAtOutcome(md.revocationEndpoint, auth, token, hint);
}

/** Best-effort revocation at the discovered revocation endpoint, as this site's client. Never
 *  throws; false when it was not confirmed (no endpoint published, no client, a refusal). */
export async function oauthRevoke(token: string, hint: "access_token" | "refresh_token"): Promise<boolean> {
  return (await oauthRevokeOutcome(token, hint)).ok;
}
