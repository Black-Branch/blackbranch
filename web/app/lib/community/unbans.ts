// The lift log (site.community_unbans, v166): an audit log. Every lifted PERMANENT site ban is
// recorded in the same statement that lifts it (who lifted it, when). Nothing reads it to act: the
// community reconciler lifts a room ban when its reason is the site's marker (siteBanReason.ts) and
// the person is no longer banned. Lifting or ending a timeout records nothing (a timeout is level −1,
// never a room ban). Rows older than UNBAN_KEEP_DAYS are pruned by the next lift.
//
// A lift of an account also reaches the canonicals linked to it at that moment, in the same
// statement: a canonical's standing is its own mod_log rows (config/canonical-standing.mjs), so the
// lift writes an 'unban' on each — or a ban from before the link would outlive the site's unban.
import { ACCOUNT_CANONICALS_SQL } from "../canonicalIdentity.ts";
import { CANONICAL_STANDING } from "../canonicalStanding.generated.mjs";
import { liftOursSql, placedBySql } from "./accountBans.ts";

const UNBAN_KEEP_DAYS = 30;
const PRUNE = `pruned AS (DELETE FROM site.community_unbans WHERE lifted_at < now() - interval '${UNBAN_KEEP_DAYS} days')`;

/** Lift whatever site ban or timeout `$1` holds; a permanent ban's lift is recorded. `$2` = the mod,
 *  `$3` = the action's batch id. Every canonical linked to `$1` now that STANDS (a ban, or a running
 *  timeout) gets an 'unban' ("lifted with <matrix id>"), whatever the account itself held: an Unban
 *  lifts the person — also a platform ban from before the link, which no site.bans row holds. A
 *  canonical with nothing standing gets no row.
 *  A DELETED account's ban also lives on its platform ids (stream.erased_restrictions, reason 'ban' —
 *  stream-api account-erase.js): the lift ends that too, as it ends a live account's ban; the
 *  daily prune (stream-api automod.js) then deletes the ended row. */
export const LIFT_BAN_SQL = `
  WITH gone AS (DELETE FROM site.bans WHERE matrix_id = $1 RETURNING matrix_id, expires_at),
  ended AS (UPDATE stream.erased_restrictions SET expires_at = now()
             WHERE matrix_id = $1 AND reason = 'ban' AND (expires_at IS NULL OR expires_at > now())),
  canonicals AS (INSERT INTO site.mod_log (action, target_id, performed_by, reason, batch_id)
                 SELECT 'unban', linked.canonical, $2, 'lifted with ' || $1, $3::uuid FROM ${ACCOUNT_CANONICALS_SQL}
                  WHERE EXISTS (SELECT 1 FROM (${CANONICAL_STANDING}) s WHERE s.target_id = linked.canonical)),
  ${PRUNE}
  INSERT INTO site.community_unbans (matrix_id, lifted_by) SELECT matrix_id, $2 FROM gone WHERE expires_at IS NULL`;

/** Lift `$1`'s running timeout only (a ban stays). `$2` = the mod, `$3` = the batch id. On the
 *  linked canonicals it lifts only the timeouts THIS account placed ("timed out with $1") and places
 *  every other standing row again (accountBans.ts liftOursSql): ending a timeout never lifts a ban,
 *  nor a timeout the canonical holds of its own (a platform timeout from before the link runs out on
 *  its own, or a full Unban lifts it). Answers how many timeouts went (the account's and the
 *  canonicals' unbans) and whether a site ban stands (read from the statement's snapshot, where the
 *  ban row is untouched). Records no unban for the account. */
export const LIFT_TIMEOUT_SQL = `
  WITH gone AS (DELETE FROM site.bans WHERE matrix_id = $1 AND expires_at > now() RETURNING matrix_id),
  canonicals AS (
    INSERT INTO site.mod_log (action, target_id, performed_by, duration_minutes, expires_at, reason, batch_id)
    SELECT l.action, l.canonical, l.performed_by, l.minutes, l.until, l.why, l.batch
      FROM (${liftOursSql({ ours: placedBySql("ARRAY[$1::text]", ["timed out with "]), mod: "$2", batch: "$3", why: "'timeout ended with '" })}) l
     WHERE NOT EXISTS (SELECT 1 FROM site.bans WHERE matrix_id = $1 AND expires_at IS NULL)
     ORDER BY l.ord, l.canonical, l.src
    RETURNING action)
  SELECT (SELECT count(*)::int FROM gone) + (SELECT count(*)::int FROM canonicals WHERE 'unban' = canonicals.action) AS lifted,
         EXISTS (SELECT 1 FROM site.bans WHERE matrix_id = $1 AND expires_at IS NULL) AS banned`;
