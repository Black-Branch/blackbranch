// Shared plumbing for the per-platform moderation modules: the audit trail
// (site.platform_mod_actions), identity-graph resolution of a target's platform
// user id, and capable-token selection (acting mod's own token when its stored
// scope grant covers the action, else the broadcaster's token as fallback).

import pool from "@/lib/db";
import { getAccessToken } from "@/app/lib/platformTokens";
import { instanceString } from "@/app/lib/instanceConfigServer";
import { NATIVE_SQL } from "@/app/lib/nativePlatform";

export type PlatformModAction = "ban" | "timeout" | "unban" | "delete" | "purge" | "slowmode";

export type ActionRecord = {
  action: PlatformModAction;
  platform: string;
  performedBy: string;
  targetId?: string | null;
  targetPlatformId?: string | null;
  broadcasterId?: string | null;
  messageId?: string | null;
  durationSeconds?: number | null;
  ok: boolean;
  status?: number | null;
  detail?: string | null;
  actedVia?: "self" | "broadcaster" | null;
  platformRef?: string | null; // e.g. YouTube liveChatBans resource id (needed for unban)
  batchId?: string | null;     // groups a purge's fan-out rows
};

// Append-only — logging must never break a mod action.
export async function record(r: ActionRecord): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO site.platform_mod_actions
         (action, platform, performed_by, target_id, target_platform_id,
          broadcaster_id, message_id, duration_seconds, ok, status, detail,
          acted_via, platform_ref, batch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        r.action, r.platform, r.performedBy, r.targetId ?? null,
        r.targetPlatformId ?? null, r.broadcasterId ?? null, r.messageId ?? null,
        r.durationSeconds ?? null, r.ok, r.status ?? null, r.detail ?? null,
        r.actedVia ?? null, r.platformRef ?? null, r.batchId ?? null,
      ]
    );
  } catch {
    // swallow — audit logging is best-effort
  }
}

// The target user's platform user id, resolved from our identity graph. The
// target may be a matrix id (a direct site.platform_links row if they linked
// the platform, else via their canonical stream identity) OR a canonical
// stream id directly — a platform-only chatter with no site account, which is
// what the UserCard's mod actions on platform-origin messages carry. Returns
// null if we have no platform id for them.
export async function targetPlatformId(target: string, platform: string): Promise<string | null> {
  const direct = await pool.query<{ platform_id: string }>(
    `SELECT platform_id FROM site.platform_links
     WHERE matrix_id = $1 AND platform = $2 LIMIT 1`,
    [target, platform]
  );
  if (direct.rows[0]?.platform_id) return direct.rows[0].platform_id;

  const viaCanonical = await pool.query<{ platform_id: string }>(
    `WITH canon AS (
       SELECT canonical_id AS c FROM site.platform_links WHERE matrix_id = $1
       UNION
       SELECT canonical   AS c FROM stream.links
         WHERE platform IN ${NATIVE_SQL} AND platform_id = $1
       UNION
       SELECT id          AS c FROM stream.users WHERE id = $1
     )
     SELECT l.platform_id
     FROM stream.links l JOIN canon ON l.canonical = canon.c
     WHERE l.platform = $2 LIMIT 1`,
    [target, platform]
  );
  return viaCanonical.rows[0]?.platform_id ?? null;
}

// The broadcaster's site identity — the fallback actor when the acting mod's own
// link can't perform a platform action. Instance key streamer.matrixId (env
// STREAMER_MATRIX_ID, alias BROADCASTER_MATRIX_ID). Fail-closed: unset means no
// fallback, never a guessed identity.
function broadcasterMatrixId(): string | null {
  return instanceString("streamer.matrixId");
}

function scopeGrants(scope: string | null, needed: string): boolean {
  if (!scope) return false;
  return scope.split(/[\s,]+/).includes(needed);
}

type ScopedAccount = { provider_account_id: string; scope: string | null };

async function loadScopedAccount(matrixId: string, platform: string): Promise<ScopedAccount | null> {
  const { rows } = await pool.query<ScopedAccount>(
    `SELECT provider_account_id, scope FROM site.accounts
     WHERE matrix_id = $1 AND provider = $2 AND type = 'oauth' LIMIT 1`,
    [matrixId, platform]
  );
  return rows[0] ?? null;
}

export type CapableToken = {
  token: string;
  /** Platform user id of the account the token belongs to (Helix moderator_id). */
  actorPlatformId: string;
  actedVia: "self" | "broadcaster";
};

/**
 * Pick the token to act with: the mod's own linked account if its STORED scope
 * grant covers `neededScope` (links predating a scope addition degrade to the
 * fallback instead of guaranteed 401s), else the broadcaster's account under the
 * same scope test. Returns null when no capable token exists — callers record a
 * `no_capable_token` skip.
 */
export async function getCapableToken(
  modMatrixId: string,
  platform: string,
  neededScope: string
): Promise<CapableToken | null> {
  const own = await loadScopedAccount(modMatrixId, platform);
  if (own && scopeGrants(own.scope, neededScope)) {
    const token = await getAccessToken(modMatrixId, platform);
    if (token) return { token, actorPlatformId: own.provider_account_id, actedVia: "self" };
  }
  return getBroadcasterToken(platform, neededScope, modMatrixId);
}

/**
 * Availability probe: WHO could perform an action needing `neededScope` —
 * "self" (the mod's own link grants it), "broadcaster" (fallback token grants
 * it), or null (nobody). Same scope test as getCapableToken but WITHOUT
 * decrypting/refreshing any token, so it's cheap enough for read endpoints
 * (the mod panel / UserCard availability view). A token that later fails to
 * refresh still surfaces at action time — this is a best-effort preview.
 */
export async function capabilityFor(
  modMatrixId: string,
  platform: string,
  neededScope: string
): Promise<"self" | "broadcaster" | null> {
  const own = await loadScopedAccount(modMatrixId, platform);
  if (own && scopeGrants(own.scope, neededScope)) return "self";
  const bmx = broadcasterMatrixId();
  if (!bmx || bmx === modMatrixId) return null;
  const acct = await loadScopedAccount(bmx, platform);
  if (acct && scopeGrants(acct.scope, neededScope)) return "broadcaster";
  return null;
}

/**
 * The broadcaster's token alone (used directly for the YouTube per-target-403
 * retry). `skipIfSameAs` avoids a pointless second attempt when the acting mod
 * IS the broadcaster.
 */
export async function getBroadcasterToken(
  platform: string,
  neededScope: string,
  skipIfSameAs?: string
): Promise<CapableToken | null> {
  const bmx = broadcasterMatrixId();
  if (!bmx || bmx === skipIfSameAs) return null;
  const acct = await loadScopedAccount(bmx, platform);
  if (!acct || !scopeGrants(acct.scope, neededScope)) return null;
  const token = await getAccessToken(bmx, platform);
  if (!token) return null;
  return { token, actorPlatformId: acct.provider_account_id, actedVia: "broadcaster" };
}
