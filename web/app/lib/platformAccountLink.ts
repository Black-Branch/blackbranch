// The write step of linking a platform account (OAuth callback
// app/api/auth/link/[platform]/callback): store the tokens in site.accounts and,
// when the account has chatted, bind it in site.platform_links.
//
// A platform account belongs to exactly ONE site account. Both tables can say who
// holds it — site.platform_links only once the account has a stream identity,
// site.accounts from the first link — so ownership is read from BOTH, before any
// write: a claim by anyone else is refused and changes nothing (the holder's
// tokens stay theirs). Re-linking by the holder refreshes the tokens.
//
// Two first claims of one account can race with no row for either to see, and
// `FOR UPDATE` cannot lock a row that does not exist yet, so each claim takes a
// transaction-scoped advisory lock on the provider account BEFORE reading. The
// unique keys stay the backstop: the accounts upsert only updates its own
// holder's row, and a unique violation reads as "already linked".
//
// Types-only pg import so `node --test` can load it; the caller passes the pool.

import type { Pool } from "pg";

export type LinkClaim = {
  matrixId: string;
  platform: string;
  platformUserId: string;
  /** Already encrypted (tokenCrypto.encToken). */
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  displayName: string;
};

export type LinkResult =
  | { linked: true; canonicalId: string | null }
  | { linked: false; owner: string | null };

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

/** Lock order: `link:<provider>:<account>` and nothing else. */
/** Who else holds a platform account: another site account (an OAuth row or a platform link), or a
 *  deleted account that left it under a ban or an open case (stream.erased_restrictions, v154 — a
 *  new account must not take over a restricted id; a timeout's record ends when the timeout does,
 *  v156). $1 platform, $2 platform id, $3 the claimant.
 *  The caller answers every one the same way ("already linked"), so nothing says it is a ban. */
export const HELD_BY_OTHER_SQL = `SELECT matrix_id FROM site.accounts
        WHERE provider = $1 AND provider_account_id = $2 AND matrix_id <> $3
       UNION ALL
       SELECT matrix_id FROM site.platform_links
        WHERE platform = $1 AND platform_id = $2 AND matrix_id <> $3
       UNION ALL
       SELECT matrix_id FROM stream.erased_restrictions
        WHERE platform = $1 AND platform_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`;

export async function claimPlatformAccount(pool: Pick<Pool, "connect">, c: LinkClaim): Promise<LinkResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`link:${c.platform}:${c.platformUserId}`]);

    const held = await client.query<{ matrix_id: string }>(HELD_BY_OTHER_SQL, [c.platform, c.platformUserId, c.matrixId]);
    const owner = held.rows[0]?.matrix_id;
    if (owner) {
      await client.query("ROLLBACK");
      return { linked: false, owner };
    }

    const stored = await client.query(
      `INSERT INTO site.accounts
         (matrix_id, type, provider, provider_account_id,
          access_token, refresh_token, expires_at, token_type, scope,
          linked_at, account_display_name)
       VALUES ($1, 'oauth', $2, $3, $4, $5, $6, 'Bearer', $7, now(), $8)
       ON CONFLICT (provider, provider_account_id) DO UPDATE SET
         access_token          = EXCLUDED.access_token,
         refresh_token         = EXCLUDED.refresh_token,
         expires_at            = EXCLUDED.expires_at,
         scope                 = EXCLUDED.scope,
         linked_at             = now(),
         account_display_name  = EXCLUDED.account_display_name
       WHERE site.accounts.matrix_id = EXCLUDED.matrix_id`,
      [c.matrixId, c.platform, c.platformUserId, c.accessToken, c.refreshToken, c.expiresAt, c.scope, c.displayName],
    );
    if (stored.rowCount === 0) {
      // Held by someone else after all (a writer outside this lock): never take it.
      await client.query("ROLLBACK");
      return { linked: false, owner: null };
    }

    // Bridge to the stream identity. No row yet = never chatted on this platform;
    // the binding is made when they first do.
    const stream = await client.query<{ canonical: string }>(
      `SELECT canonical FROM stream.links WHERE platform = $1 AND platform_id = $2 LIMIT 1`,
      [c.platform, c.platformUserId],
    );
    const canonicalId = stream.rows[0]?.canonical ?? null;
    if (canonicalId) {
      await client.query(
        `INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (matrix_id, platform) DO UPDATE SET
           platform_id  = EXCLUDED.platform_id,
           canonical_id = EXCLUDED.canonical_id`,
        [c.matrixId, c.platform, c.platformUserId, canonicalId],
      );
    }

    await client.query("COMMIT");
    return { linked: true, canonicalId };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(e)) return { linked: false, owner: null };
    throw e;
  } finally {
    client.release();
  }
}
