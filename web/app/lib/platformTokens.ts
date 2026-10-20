// Server-side platform token access — the single way action routes obtain a
// stored platform OAuth token. Handles decryption, expiry checks, and refresh.
// Mirrors the pattern of matrixSession.ts.

import pool from "@/lib/db";
import { encToken, decToken } from "@/app/lib/tokenCrypto";
import { getPlatformConfig } from "@/app/lib/platformOAuth";

type AccountRow = {
  id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | number | null;
};

// Deduplicate concurrent refresh calls for the same account row.
const inFlight = new Map<string, Promise<string | null>>();

async function loadAccount(matrixId: string, platform: string): Promise<AccountRow | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT id, provider, access_token, refresh_token, expires_at
     FROM site.accounts
     WHERE matrix_id = $1 AND provider = $2 AND type = 'oauth'
     LIMIT 1`,
    [matrixId, platform]
  );
  return rows[0] ?? null;
}

async function doRefresh(row: AccountRow): Promise<string | null> {
  const config = getPlatformConfig(row.provider);
  if (!config) return null;

  const storedRefresh = decToken(row.refresh_token);
  if (!storedRefresh) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: storedRefresh,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.error(`[platformTokens] refresh failed for ${row.provider} (site.accounts id ${row.id}):`, res.status);
    return null;
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const newExpires = Date.now() + (data.expires_in ?? 3600) * 1000;
  await pool.query(
    `UPDATE site.accounts
     SET access_token = $1, refresh_token = $2, expires_at = $3
     WHERE id = $4`,
    [
      encToken(data.access_token),
      encToken(data.refresh_token ?? storedRefresh),
      newExpires,
      row.id,
    ]
  );

  return data.access_token;
}

/**
 * Retrieve a valid platform access token for the given Matrix user and platform.
 * Automatically refreshes if expired. Returns null if not linked or refresh fails.
 */
export async function getAccessToken(matrixId: string, platform: string): Promise<string | null> {
  const row = await loadAccount(matrixId, platform);
  if (!row) return null;

  const access = decToken(row.access_token);
  const expires = Number(row.expires_at ?? 0);

  // Valid token: at least 60s remaining
  if (access && expires && Date.now() < expires - 60_000) return access;

  // Refresh — deduplicated by account row id
  const existing = inFlight.get(row.id);
  if (existing) return existing;

  const p = doRefresh(row).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, p);
  return p;
}
