// AT Protocol OAuth client (stream.place cross-posting).
// Confidential web client using @atproto/oauth-client-node — handles PAR, DPoP,
// PKCE, and token refresh. State + session are persisted in Postgres so the
// DPoP-bound session survives restarts and can be restored to post records.

import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type {
  NodeSavedState,
  NodeSavedStateStore,
  NodeSavedSession,
  NodeSavedSessionStore,
} from "@atproto/oauth-client-node";
import type { OAuthClientMetadataInput } from "@atproto/oauth-client";
import { JoseKey } from "@atproto/jwk-jose";
import pool from "@/lib/db";
import { packSecret, unpackSecret } from "./atprotoSecretStore";
import { installValue } from "./installValues.ts";
import { siteName } from "./siteName.ts";

// The client_id is a URL on this site, so it is the site's own origin (install key site.origin).
const BASE_URL = installValue("site.origin");

// Single source of truth for the client metadata document (served at the
// client_id URL) — also reused by the /oauth/client-metadata.json route.
export function clientMetadata(): OAuthClientMetadataInput {
  return {
    client_id: `${BASE_URL}/oauth/client-metadata.json`,
    client_name: siteName(),
    client_uri: BASE_URL,
    redirect_uris: [`${BASE_URL}/api/auth/link/streamplace/callback`],
    scope: "atproto transition:generic",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_signing_alg: "ES256",
    dpop_bound_access_tokens: true,
    jwks_uri: `${BASE_URL}/oauth/jwks.json`,
  };
}

// The state/session blobs carry live OAuth secrets (tokens + DPoP private key),
// so they are encrypted at rest via packSecret/unpackSecret (AES-256-GCM, same
// key as Matrix tokens). Those helpers are backward compatible: legacy plaintext
// rows still read, and the store falls back to plaintext when no key is set.
const stateStore: NodeSavedStateStore = {
  async set(key: string, val: NodeSavedState) {
    await pool.query(
      `INSERT INTO site.atproto_oauth_state (key, state) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, created_at = now()`,
      [key, packSecret(val)]
    );
  },
  async get(key: string) {
    const { rows } = await pool.query<{ state: unknown }>(
      `SELECT state FROM site.atproto_oauth_state WHERE key = $1`,
      [key]
    );
    return unpackSecret<NodeSavedState>(rows[0]?.state);
  },
  async del(key: string) {
    await pool.query(`DELETE FROM site.atproto_oauth_state WHERE key = $1`, [key]);
  },
};

const sessionStore: NodeSavedSessionStore = {
  async set(did: string, val: NodeSavedSession) {
    await pool.query(
      `INSERT INTO site.atproto_sessions (did, session, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (did) DO UPDATE SET session = EXCLUDED.session, updated_at = now()`,
      [did, packSecret(val)]
    );
  },
  async get(did: string) {
    const { rows } = await pool.query<{ session: unknown }>(
      `SELECT session FROM site.atproto_sessions WHERE did = $1`,
      [did]
    );
    return unpackSecret<NodeSavedSession>(rows[0]?.session);
  },
  async del(did: string) {
    await pool.query(`DELETE FROM site.atproto_sessions WHERE did = $1`, [did]);
  },
};

let clientPromise: Promise<NodeOAuthClient> | null = null;

export function getAtprotoClient(): Promise<NodeOAuthClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const raw = process.env.ATPROTO_PRIVATE_JWK;
      if (!raw) throw new Error("ATPROTO_PRIVATE_JWK is not set");
      const key = await JoseKey.fromImportable(JSON.parse(raw), "key1");
      return new NodeOAuthClient({
        clientMetadata: clientMetadata(),
        keyset: [key],
        handleResolver: "https://bsky.social",
        stateStore,
        sessionStore,
      });
    })().catch((e) => {
      // Don't cache the rejection — a transient/bad-config failure would
      // otherwise poison every subsequent call until restart. Allow retry.
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}
