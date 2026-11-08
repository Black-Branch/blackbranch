// The site ban or timeout of ONE account, written in one statement: the account's own row
// (site.bans — the account's truth) and the same action on every canonical linked to it at this
// moment (their truth is their own mod_log rows, config/canonical-standing.mjs). So the two truths
// agree from here on, and an unlink later leaves the canonical as banned as the account.
// The Mod Panel's ban route (app/api/mod/ban/route.ts) runs it after its downgrade guard.
import { ACCOUNT_CANONICALS_SQL } from "../canonicalIdentity.ts";
import { CANONICAL_STANDING } from "../canonicalStanding.generated.mjs";

/**
 * Rows that lift what an account placed on its linked canonicals and NOTHING else — for a
 * reduction (BAN_ACCOUNT_SQL) and an early end of a timeout (unbans.ts LIFT_TIMEOUT_SQL).
 *
 * An 'unban' lifts every lower-id row on a canonical, so where a canonical's standing has a row
 * that is OURS (`ours`, a predicate on `r`, that row's site.mod_log entry), this yields:
 *   ord 1 — the 'unban' (`$mod`, reason `why` || the account `$1`, batch `$batch`);
 *   ord 2 — every standing row NOT ours placed again as a new row, unchanged (its own action, end,
 *           reason, who and batch), so a ban or timeout the canonical holds of its own — a platform
 *           ban from before the link, a merge-carried one, one placed through another account —
 *           outlives the lift (as mergeCanonicals carries a standing row).
 * The caller adds its own rows (ord 3) and inserts them ORDERED BY ord, canonical, src, so the
 * unban takes the lowest id. Columns: ord, canonical, src, action, performed_by, minutes, until,
 * why, batch. `$1` is the account (ACCOUNT_CANONICALS_SQL).
 */
export function liftOursSql(o: { ours: string; mod: string; batch: string; why: string }): string {
  const oursHere = `EXISTS (SELECT 1 FROM (${CANONICAL_STANDING}) s JOIN site.mod_log r ON r.id = s.id
                             WHERE s.target_id = linked.canonical AND (${o.ours}))`;
  return `
    SELECT 1 AS ord, linked.canonical, 0::bigint AS src, 'unban'::text AS action, ${o.mod}::text AS performed_by,
           NULL::int AS minutes, NULL::timestamptz AS until, ${o.why} || $1 AS why, ${o.batch}::uuid AS batch
      FROM ${ACCOUNT_CANONICALS_SQL}
     WHERE ${oursHere}
    UNION ALL
    SELECT 2, linked.canonical, r.id, r.action, r.performed_by, r.duration_minutes, r.expires_at, r.reason, r.batch_id
      FROM ${ACCOUNT_CANONICALS_SQL}
      JOIN (${CANONICAL_STANDING}) s ON s.target_id = linked.canonical
      JOIN site.mod_log r ON r.id = s.id
     WHERE NOT (${o.ours}) AND ${oursHere}`;
}

/**
 * Was the row `r` placed with one of `accounts` (SQL for a text[]) — its reason one of `words` + the
 * account? The reason is the provenance: "banned with" / "timed out with" <matrix id> are written by
 * this file and modTimeout.ts. The same text CAN also come from a mod's typed reason on an UNLINKED
 * canonical (CANONICAL_ACTION_SQL stores it as is); only a mod can do that, so it is noted, not
 * guarded — at worst that row is later treated as the named account's. A merge keeps it and appends a note
 * (stream-api identity.js: "<reason> · carried by merge from <loser>"), so a carried row is still
 * the account's: the reason equals the words + account, or starts with them + " · ". starts_with,
 * never LIKE — a matrix id may hold `_` or `%`. An EXISTS is never NULL, so a row without a reason
 * is simply not ours (and `NOT (…)` keeps it).
 */
export function placedBySql(accounts: string, words: readonly string[]): string {
  return `EXISTS (SELECT 1 FROM unnest(${accounts}) a, (VALUES ${words.map((w) => `('${w}')`).join(", ")}) v(w)
                   WHERE r.reason = v.w || a OR starts_with(r.reason, v.w || a || ' · '))`;
}

/** Ours for a ban-route action: a row placed with any account this action covers ($8). */
const PLACED_BY_COVERED = placedBySql("$8::text[]", ["banned with ", "timed out with "]);

/** $1 matrix id, $2 the mod, $3 reason, $4 expires_at (null = permanent), $5 'ban' | 'timeout',
 *  $6 duration minutes, $7 the action's batch id, $8 every account this action covers (a ban by a
 *  canonical covers each account linked to it). Answers `kept_identities`: in a reduction, the
 *  linked canonicals that keep a ban — or a timeout running past the new one — of their own.
 *
 *  A deliberate REDUCTION (the route's override, or the panel's Undo: a ban replaced by a timeout, a
 *  timeout by a shorter one) lifts what this action's accounts placed on their canonicals and places
 *  the weaker action (liftOursSql): a timeout never weakens a ban on a canonical and a shorter
 *  timeout never ends a longer one, so without the lift the account would be free while its
 *  canonical stayed banned. Rows the canonical holds of its own are placed again, never lifted —
 *  only a full site Unban (LIFT_BAN_SQL) lifts them. */
export const BAN_ACCOUNT_SQL = `
  WITH prior AS (
    SELECT expires_at FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > now())),
  b AS (
    INSERT INTO site.bans (matrix_id, banned_by, reason, expires_at)
    VALUES ($1, $2, $3, $4::timestamptz)
    ON CONFLICT (matrix_id) DO UPDATE
      SET banned_by = $2, reason = $3, expires_at = $4::timestamptz, created_at = NOW()
    RETURNING matrix_id),
  reduces AS (
    SELECT EXISTS (SELECT 1 FROM prior
                    WHERE $4::timestamptz IS NOT NULL AND (prior.expires_at IS NULL OR prior.expires_at > $4::timestamptz)) AS yes),
  w AS (
    INSERT INTO site.mod_log (action, target_id, performed_by, duration_minutes, expires_at, reason, batch_id)
    SELECT x.action, x.canonical, x.performed_by, x.minutes, x.until, x.why, x.batch
      FROM (SELECT * FROM (${liftOursSql({ ours: PLACED_BY_COVERED, mod: "$2", batch: "$7", why: "'reduced with '" })}) l
             WHERE (SELECT yes FROM reduces)
            UNION ALL
            SELECT 3, linked.canonical, 0::bigint, $5::text, $2::text, $6::int, $4::timestamptz,
                   CASE WHEN $5::text = 'ban' THEN 'banned with ' ELSE 'timed out with ' END || $1, $7::uuid
              FROM ${ACCOUNT_CANONICALS_SQL}) x
     WHERE EXISTS (SELECT 1 FROM b)
     ORDER BY x.ord, x.canonical, x.src
    RETURNING 1)
  SELECT COALESCE((
    SELECT array_agg(DISTINCT s.target_id)
      FROM ${ACCOUNT_CANONICALS_SQL}
      JOIN (${CANONICAL_STANDING}) s ON s.target_id = linked.canonical
      JOIN site.mod_log r ON r.id = s.id
     WHERE (SELECT yes FROM reduces) AND NOT (${PLACED_BY_COVERED})
       AND (s.action = 'ban' OR s.expires_at > $4::timestamptz)), '{}') AS kept_identities`;

/** A platform-only chatter's ban, timeout or unban: a row on the canonical itself, which IS its
 *  standing — so, unlike the audit log (modlog.ts appendModLog), a failed write throws.
 *  $1 action, $2 canonical, $3 the mod, $4 duration minutes, $5 expires_at, $6 reason, $7 batch id. */
export const CANONICAL_ACTION_SQL = `
  INSERT INTO site.mod_log (action, target_id, performed_by, duration_minutes, expires_at, reason, batch_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;
