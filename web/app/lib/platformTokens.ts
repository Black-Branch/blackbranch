// Server-side platform token access — the single way action routes obtain a
// stored platform OAuth token. Handles decryption, expiry checks, and refresh.
// Mirrors the pattern of matrixSession.ts.
//
// A REFUSED refresh (the platform answers 400/401: the person revoked the app, or the grant aged
// out) is permanent until they link again. It is stamped on the row (site.accounts
// refresh_failed_at, v160) and the platform is not asked again — otherwise every send re-tries it
// and logs the same 401 forever, and nobody is told. The
// account panel reads the stamp and offers "Reconnect". Linking again
// (platformAccountLink.ts) and a later successful refresh clear it. Any other failure (a 5xx, a
// timeout) is transient and stamps nothing.

import pool from "@/lib/db";
import { encToken, decToken } from "@/app/lib/tokenCrypto";
import { getPlatformConfig } from "@/app/lib/platformOAuth";

type AccountRow = {
  id: string;
  provider: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | number | null;
  refresh_failed_at: Date | string | null;
};

type Deps = {
  query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }>;
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  config: (provider: string) => { clientId: string; clientSecret: string; tokenUrl: string } | null;
  enc: (v: string) => string | null;
  dec: (v: string | null) => string | null;
  now: () => number;
  log: Pick<Console, "error" | "warn">;
};

const realDeps: Deps = {
  query: async <R,>(sql: string, params: unknown[]) => (await pool.query(sql, params)) as unknown as { rows: R[] },
  fetch: (url, init) => fetch(url, init),
  config: (p) => getPlatformConfig(p),
  enc: (v) => encToken(v),
  dec: (v) => decToken(v),
  now: () => Date.now(),
  log: console,
};

/** The refresh answers that mean "this grant is dead" rather than "try later". */
const REFUSED = new Set([400, 401]);

/** @test-only the factory takes stub deps; production uses getAccessToken below. */
export function createPlatformTokens(deps: Deps = realDeps) {
  // Deduplicate concurrent refresh calls for the same account row.
  const inFlight = new Map<string, Promise<string | null>>();

  async function loadAccount(matrixId: string, platform: string): Promise<AccountRow | null> {
    const { rows } = await deps.query<AccountRow>(
      `SELECT id, provider, access_token, refresh_token, expires_at, refresh_failed_at
       FROM site.accounts
       WHERE matrix_id = $1 AND provider = $2 AND type = 'oauth'
       LIMIT 1`,
      [matrixId, platform]
    );
    return rows[0] ?? null;
  }

  async function doRefresh(row: AccountRow): Promise<string | null> {
    const config = deps.config(row.provider);
    if (!config) return null;

    const storedRefresh = deps.dec(row.refresh_token);
    if (!storedRefresh) return null;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: storedRefresh,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const res = await deps.fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (REFUSED.has(res.status)) {
        // Permanent: stamp it (once — the next call never gets here) and stop asking.
        await deps.query(`UPDATE site.accounts SET refresh_failed_at = now() WHERE id = $1 AND refresh_failed_at IS NULL`, [row.id]);
        deps.log.warn(`[platformTokens] ${row.provider} refused the refresh (${res.status}) for site.accounts id ${row.id} — marked expired; the person is asked to reconnect`);
      } else {
        deps.log.error(`[platformTokens] refresh failed for ${row.provider} (site.accounts id ${row.id}):`, res.status);
      }
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpires = deps.now() + (data.expires_in ?? 3600) * 1000;
    await deps.query(
      `UPDATE site.accounts
       SET access_token = $1, refresh_token = $2, expires_at = $3, refresh_failed_at = NULL
       WHERE id = $4`,
      [
        deps.enc(data.access_token),
        deps.enc(data.refresh_token ?? storedRefresh),
        newExpires,
        row.id,
      ]
    );

    return data.access_token;
  }

  /**
   * Retrieve a valid platform access token for the given Matrix user and platform.
   * Automatically refreshes if expired. Returns null if not linked, refresh fails, or the
   * platform already refused this link's refresh (it needs reconnecting).
   */
  return async function getAccessToken(matrixId: string, platform: string): Promise<string | null> {
    const row = await loadAccount(matrixId, platform);
    if (!row) return null;

    const access = deps.dec(row.access_token);
    const expires = Number(row.expires_at ?? 0);

    // Valid token: at least 60s remaining
    if (access && expires && deps.now() < expires - 60_000) return access;

    // Refused before: the platform will refuse again until the person reconnects.
    if (row.refresh_failed_at) return null;

    // Refresh — deduplicated by account row id
    const existing = inFlight.get(row.id);
    if (existing) return existing;

    const p = doRefresh(row).finally(() => inFlight.delete(row.id));
    inFlight.set(row.id, p);
    return p;
  };
}

const G = globalThis as typeof globalThis & { __platformTokens?: ReturnType<typeof createPlatformTokens> };

/**
 * Retrieve a valid platform access token for the given Matrix user and platform.
 * Automatically refreshes if expired. Returns null if not linked, refresh fails, or the link
 * needs reconnecting (see the header).
 */
export function getAccessToken(matrixId: string, platform: string): Promise<string | null> {
  return (G.__platformTokens ??= createPlatformTokens())(matrixId, platform);
}
