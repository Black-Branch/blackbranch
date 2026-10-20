// Unlinking a platform account from a site account (Linked Accounts → Unlink; DELETE
// /api/account-links). SERVER ONLY; dependency-free so `node --test` can load it — the route hands
// it the pool and the calls.
//
// Linking MERGES the platform account's stream identity into the person's (stream-api
// mergeCanonicals). Removing only our rows (site.accounts, site.platform_links) left that merge in
// place: the unlinked account's chat, support and stats kept adding to the person, polls, pronouns
// and the first-message badge stayed shared, and when ANOTHER site account later linked the same
// platform account, its merge folded two different people into one. stream-api's
// POST /identity/unlink undoes the merge for that one platform account: a fresh identity, which
// carries any open mark or ban (identity.js).
//
// ORDER, and why:
//   1. stream-api's unlink FIRST. Its ownership check reads site.platform_links, so the row must
//      still be there. If the call fails (stream-api down, a 5xx, no answer) NOTHING is removed and
//      the person is told to try again (503): our rows gone with the merge in place is the bug
//      this exists to fix, and it could never be retried.
//   2. Then the provider revoke and our rows, as before.
// stream-api's 404 (the platform account never chatted — no identity to separate) and 409 (its
// identity is not tied to THIS account, so there is no merge of ours to undo) are answers, not
// failures: the unlink goes on, so a person can always take back their grant.

export type UnlinkQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type UnlinkDeps = {
  query: UnlinkQuery;
  /** POST /identity/unlink on stream-api; the HTTP status, or a throw when there was no answer. */
  streamUnlink: (body: { matrixId: string; platform: string; platformId: string }) => Promise<number>;
  /** Revoke the grant at the provider (best effort; never throws). */
  revoke: (platform: string, tokens: { access: string | null; refresh: string | null }) => Promise<void>;
  decrypt: (stored: string | null) => string | null;
};

export type UnlinkResult = { ok: true } | { ok: false; status: 503; error: string };

/** The platform account's own id on that platform, for the stream-side unlink: the identity link
 *  (site.platform_links) when it exists, else the OAuth row's account id (linked, maybe never bound). */
async function platformAccountId(matrixId: string, platform: string, query: UnlinkQuery): Promise<string | null> {
  const { rows } = await query(
    `SELECT id FROM (
       SELECT platform_id AS id, 0 AS src FROM site.platform_links WHERE matrix_id = $1 AND platform = $2
       UNION ALL
       SELECT provider_account_id AS id, 1 AS src FROM site.accounts
        WHERE matrix_id = $1 AND provider = $2 AND type IN ('oauth', 'atproto')
     ) ids ORDER BY src LIMIT 1`,
    [matrixId, platform],
  );
  const id = rows[0]?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

export async function unlinkPlatformAccount(matrixId: string, platform: string, deps: UnlinkDeps): Promise<UnlinkResult> {
  const retry: UnlinkResult = { ok: false, status: 503, error: "Couldn't unlink right now — nothing was changed. Try again in a moment." };

  // 1. Separate the stream identity while the link row still proves ownership.
  const platformId = await platformAccountId(matrixId, platform, deps.query);
  if (platformId) {
    let status: number;
    try {
      status = await deps.streamUnlink({ matrixId, platform, platformId });
    } catch {
      return retry;
    }
    if (status === 409) {
      console.warn(`[account-links] stream identity of ${platform}:${platformId} is not tied to ${matrixId}; unlinking the site rows only`);
    } else if (!(status >= 200 && status < 300) && status !== 404) {
      return retry;
    }
  }

  // 2. Revoke the grant AT THE PROVIDER before deleting our copy — otherwise the authorization stays
  //    listed in the person's provider account. Best effort; the privacy policy promises unlink = revoke.
  const { rows: tok } = await deps.query(
    `SELECT access_token, refresh_token FROM site.accounts
     WHERE matrix_id = $1 AND provider = $2 AND type = 'oauth' LIMIT 1`,
    [matrixId, platform],
  );
  if (tok[0]) {
    await deps.revoke(platform, {
      access: deps.decrypt((tok[0].access_token as string | null) ?? null),
      refresh: deps.decrypt((tok[0].refresh_token as string | null) ?? null),
    });
  }

  // stream.place: drop the ATProto DPoP session (keyed by DID) too.
  if (platform === "streamplace") {
    await deps.query(
      `DELETE FROM site.atproto_sessions WHERE did IN (
         SELECT provider_account_id FROM site.accounts
         WHERE matrix_id = $1 AND provider = 'streamplace')`,
      [matrixId],
    );
  }

  await deps.query(
    `DELETE FROM site.accounts WHERE matrix_id = $1 AND provider = $2 AND type IN ('oauth', 'atproto')`,
    [matrixId, platform],
  );
  // The missing site.platform_links row also ends the shown link: the one consent predicate needs
  // every platform account on a canonical to be live-linked (config/public-id.mjs noOptOutSql).
  await deps.query(`DELETE FROM site.platform_links WHERE matrix_id = $1 AND platform = $2`, [matrixId, platform]);
  return { ok: true };
}
