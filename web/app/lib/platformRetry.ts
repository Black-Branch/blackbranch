// Whether a failed platform fan-out row (site.platform_mod_actions) may still be retried.
// Dependency-free so `node --test` can run it against a real Postgres (the routes hand it the
// query); supersededLabel is the Mod history row's words, used by the panel too.
//
// A Retry re-runs a ban, timeout or unban on a platform as the current mod. Replaying an OLD row
// re-banned someone the site has since unbanned, restarted a timeout that had ended at its full
// length, or let an old failed unban lift the ban the person is serving now. So a row is retryable
// only while its batch is still the target's NEWEST ban / timeout / unban in site.mod_log, and a
// timeout only for the time it has left. Otherwise the row says what superseded it, and the retry
// route answers 409. A merge's carried rows are not an action (NEWEST_SQL skips them) — but one can
// make the person banned, so an UNBAN is also refused while the target is banned now (bannedNow, the
// standing rule): a stale unban never lifts a ban the person carries.

import { linkedMatrixIds, type LinkQuery } from "./canonicalIdentity.ts";
import { CANONICAL_STANDING } from "./canonicalStanding.generated.mjs";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** The newest ban / timeout / unban per target (site.mod_log — the one record every one writes) that
 *  a MOD or an account action made. A merge's carried rows (stream-api identity.js: performed_by
 *  'system', the reason holding "carried by merge from <loser>") are skipped: a merge is not a
 *  moderation decision, and its rows (new, now(), no batch) would otherwise read as the newest
 *  action and refuse every retry of the target's last real one ("Too old to retry"). */
const NEWEST_SQL = `
  SELECT DISTINCT ON (target_id) target_id, batch_id::text AS batch_id, action, expires_at
    FROM site.mod_log
   WHERE target_id = ANY($1::text[]) AND action IN ('ban', 'timeout', 'unban')
     AND NOT (performed_by = 'system' AND COALESCE(strpos(reason, 'carried by merge from '), 0) > 0)
   ORDER BY target_id, created_at DESC, id DESC`;

type Newest = {
  batchId: string | null; action: string; expiresAt: Date | null;
  /** Banned now by the standing rule (bannedNow) — read for every target, carried rows included. */
  banned: boolean;
};

/** What stands in the way of a retry: a later action, the timeout's end, or no record to judge by. */
export type Superseded = "ban" | "timeout" | "unban" | "ended" | "unknown";
export type RetryStanding = { ok: true; durationSeconds: number | null } | { ok: false; supersededBy: Superseded };

/** The newest ban / timeout / unban of each target, read once for many rows. */
export async function newestActions(targets: string[], query: Query): Promise<Map<string, Newest>> {
  const out = new Map<string, Newest>();
  const ids = [...new Set(targets.filter((t) => typeof t === "string" && t !== ""))];
  if (!ids.length) return out;
  for (const r of (await query(NEWEST_SQL, [ids])).rows) {
    const target = String(r.target_id);
    out.set(target, {
      batchId: typeof r.batch_id === "string" ? r.batch_id : null,
      action: String(r.action),
      expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
      banned: await bannedNow(target, query),
    });
  }
  return out;
}

/** Pure: may this row be retried, given its target's newest action? A timeout gets what is left. */
export function standingOf(
  row: { action: string; batch_id: string | null },
  newest: Newest | undefined,
  now = Date.now(),
): RetryStanding {
  if (!row.batch_id || !newest || !newest.batchId) return { ok: false, supersededBy: "unknown" };
  if (newest.batchId !== row.batch_id) {
    const a = newest.action;
    return { ok: false, supersededBy: a === "ban" || a === "timeout" || a === "unban" ? a : "unknown" };
  }
  // A stale unban must not lift a ban the person serves now — one a merge carried onto them included.
  if (row.action === "unban" && newest.banned) return { ok: false, supersededBy: "ban" };
  if (row.action !== "timeout") return { ok: true, durationSeconds: null };
  const left = newest.expiresAt ? newest.expiresAt.getTime() - now : 0;
  if (left <= 0) return { ok: false, supersededBy: "ended" };
  return { ok: true, durationSeconds: Math.ceil(left / 1000) };
}

/** Is the sender of a held line, named by canonical `target`, banned NOW? The automod Allow asks it
 *  before posting: the chat door bridges a canonical's ban for 15 minutes only (stream-api
 *  ban-hold.js), so an Allow later than that would post a banned sender's line.
 *  THE RULE (config/canonical-standing.mjs, the one fragment ban-hold.js reads too): banned when a
 *  site account linked to the canonical has a running site.bans row, OR the canonical's own standing
 *  has a row (its mod_log rows by id: a ban until a later unban on it, a timeout while it runs).
 *  Account-targeted mod_log rows are history and are never read here. A failed read throws. */
export async function bannedNow(target: string, query: Query): Promise<boolean> {
  const accounts = await linkedMatrixIds(target, query as LinkQuery);
  if (accounts.length) {
    const { rows } = await query(
      `SELECT 1 FROM site.bans WHERE matrix_id = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
      [accounts]);
    if (rows.length > 0) return true;
  }
  const { rows } = await query(`SELECT 1 FROM (${CANONICAL_STANDING}) s WHERE s.target_id = $1 LIMIT 1`, [target.toLowerCase()]);
  return rows.length > 0;
}

/** The words a row shows in place of Retry. */
export function supersededLabel(s: Superseded): string {
  if (s === "ended") return "Timeout has ended";
  if (s === "unknown") return "Too old to retry";
  return `Superseded by a later ${s}`;
}
