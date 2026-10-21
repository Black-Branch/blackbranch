import { NATIVE_SQL } from "./nativePlatform.ts";
// The fields of stream-api's /user/lookup that GET /api/user/[id] may hand to anyone. That route is
// public (no sign-in), and the lookup also carries what no stranger should read — the exact
// lifetime support total, whatever a site plugin adds (its bot's free-text read on the person),
// and the AI scoring read on the person (camp / temperament and its rank, the intelligence, word
// count and regularity tiers, average words — never public). So the route copies
// the fields a card renders, by name, and nothing else: a field stream-api adds later stays private
// until it is listed here.

const PUBLIC_PROFILE_FIELDS = [
  "name", "karma", "activity", "streams", "isMember", "subTier", "supportTier",
] as const;

// Never forwarded, whatever an installed plugin declares: the exact lifetime support total and the
// canonical id (which stays on the server).
const NEVER_FORWARDED: ReadonlySet<string> = new Set(["support", "canonicalId"]);

/** The card's fields of a lookup: the product's fixed list, plus the fields the INSTALLED plugin
 *  declares (`pluginFields`, app/lib/plugins/profile.ts pluginProfileFields — empty on an install
 *  without one, so the public product forwards exactly PUBLIC_PROFILE_FIELDS). */
export function publicProfileFields(lookup: Record<string, unknown>, pluginFields: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_PROFILE_FIELDS) if (Object.hasOwn(lookup, k)) out[k] = lookup[k];
  for (const k of pluginFields) if (!NEVER_FORWARDED.has(k) && Object.hasOwn(lookup, k)) out[k] = lookup[k];
  return out;
}

// ── One identity's stats ──────────────────────────────────────────────────────
// A caller who may not see the person's cross-platform link (not the person, not a moderator, no
// opt-in) gets the stats of the ONE identity asked about — one canonical on one platform — always,
// whether or not the person has linked anything. Showing merged stats only when nothing is linked
// (and nothing otherwise) published the link as one bit: a card with no stats meant "linked".
// Same formulas as stream-api's aggregates (karma = the last 100 scored lines, default 0.5;
// membership and tier from the newest line); the support tier is a percentile over whole people,
// so it has no one-identity value and stays with the merged view.

/** $1 = the canonical, $2 = the platform (lower case), or NULL for the site's own lines. */
export const IDENTITY_STATS_SQL = `WITH l AS (
    SELECT stream_id, karma, created_at, is_member, tier FROM stream.chat_log
     WHERE user_id = $1 AND (($2::text IS NULL AND platform IN ${NATIVE_SQL}) OR lower(platform) = $2::text)
  )
  SELECT (SELECT COUNT(*) FROM l)::int AS activity,
         (SELECT COUNT(DISTINCT stream_id) FROM l)::int AS streams,
         COALESCE((SELECT AVG(k) FROM (SELECT karma AS k FROM l WHERE karma IS NOT NULL ORDER BY created_at DESC LIMIT 100) x), 0.5)::float AS karma,
         COALESCE((SELECT is_member FROM l ORDER BY created_at DESC LIMIT 1), false) AS is_member,
         (SELECT NULLIF(TRIM(tier), '') FROM l ORDER BY created_at DESC LIMIT 1) AS sub_tier`;

export type IdentityStatsRow = { activity: number; streams: number; karma: number; is_member: boolean; sub_tier: string | null };

/** The card fields of one identity's stats row — the same names the merged lookup uses. */
export function identityStatsFields(row: IdentityStatsRow | undefined): Record<string, unknown> {
  if (!row) return {};
  return { karma: Number(row.karma), activity: row.activity, streams: row.streams, isMember: row.is_member, subTier: row.sub_tier ?? null };
}
