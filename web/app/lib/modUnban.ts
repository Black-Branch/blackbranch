// A permanent ban placed above your rank needs that rank to lift or change. A permanent ban takes a
// mod's role away (ban route banAccount), so the ceiling — which reads the target's role NOW — would
// let any mod lift the ban that removed a mod; this check reads who PLACED the ban instead.
// The placer's rank is their role now (modCeiling.ts roleRank): an admin's ban needs an admin, a
// Staff member's needs Staff or an admin, a mod's any mod. A timeout is not covered: it ends on its
// own, and a timed-out mod keeps the role, so the ceiling still guards it.
//
// What is checked is everything the action removes. An Unban (community/unbans.ts LIFT_BAN_SQL)
// lifts the account's site.bans row AND writes an 'unban' on every canonical linked to it that stands
// — so a standing ban on one of those canonicals (its own mod_log row, config/canonical-standing.mjs)
// counts, by its performed_by. An unlinked canonical's Unban lifts that canonical's own standing ban.
// (The account's stream.erased_restrictions 'ban' row, which the lift also ends, exists only for a
// deleted account, whose tombstone keeps its site.bans row — the placer read here.)
// Replacing a ban (POST) checks only the account's site.bans row: a new ban never weakens a
// canonical's own ban (a reduction keeps it — accountBans.ts), so those are not this action's to lift.

import { roleRank } from "./modCeiling.ts";
import { ACCOUNT_CANONICALS_SQL } from "./canonicalIdentity.ts";
import { CANONICAL_STANDING } from "./canonicalStanding.generated.mjs";

/** True when the ban's placer outranks the person lifting it. banLiftRefusal below is its caller.
 *  @test-only exported so modUnban.test.ts pins the rank rule without a query. */
export function liftDenied(o: { bannerRank: number; actorRank: number }): boolean {
  return o.bannerRank > o.actorRank;
}

type Row = { placer?: string | null; matrix_id?: string; is_admin?: boolean | null; is_staff?: boolean | null; is_mod?: boolean | null };
export type LiftQuery = (sql: string, params: unknown[]) => Promise<{ rows: Row[] }>;

// $1 = one account: the placer of its standing permanent site ban.
const ACCOUNT_BAN_PLACER_SQL = `SELECT banned_by AS placer FROM site.bans WHERE matrix_id = $1 AND expires_at IS NULL`;
// $1 = one account: the placers of the standing permanent bans on the canonicals linked to it now.
const LINKED_CANONICAL_BAN_PLACERS_SQL = `
  SELECT l.performed_by AS placer
    FROM (${CANONICAL_STANDING}) s JOIN site.mod_log l ON l.id = s.id
   WHERE s.action = 'ban' AND s.target_id IN (SELECT linked.canonical FROM ${ACCOUNT_CANONICALS_SQL})`;
// $1 = one canonical: the placers of its own standing permanent bans.
const CANONICAL_BAN_PLACERS_SQL = `
  SELECT l.performed_by AS placer
    FROM (${CANONICAL_STANDING}) s JOIN site.mod_log l ON l.id = s.id
   WHERE s.action = 'ban' AND s.target_id = $1`;
const ROLES_SQL = `SELECT matrix_id, is_admin, is_staff, is_mod FROM site.users WHERE matrix_id = ANY($1::text[])`;

const WHO: Record<number, string> = { 100: "An admin", 75: "A member of staff" };
const WHOM: Record<number, string> = { 100: "an admin", 75: "staff or an admin" };

/** What the action removes: `lift` — an Unban of these accounts (their site bans and their linked
 *  canonicals' bans) and of these unlinked canonicals; `replace` — a ban written over these accounts'
 *  site bans. */
export type LiftScope = { kind: "lift" | "replace"; accounts: string[]; canonicals?: string[] };

/** 403 when anything the action removes is a permanent ban placed above `actorId`'s rank; 503 when
 *  that cannot be read (fails closed); else null. Read on every request, before anything is written. */
export async function banLiftRefusal(actorId: string, scope: LiftScope, query: LiftQuery): Promise<Response | null> {
  const placers = new Set<string>();
  try {
    for (const account of scope.accounts) {
      const sqls = scope.kind === "lift" ? [ACCOUNT_BAN_PLACER_SQL, LINKED_CANONICAL_BAN_PLACERS_SQL] : [ACCOUNT_BAN_PLACER_SQL];
      for (const sql of sqls) for (const r of (await query(sql, [account])).rows) if (r.placer) placers.add(r.placer);
    }
    if (scope.kind === "lift") {
      for (const c of scope.canonicals ?? []) for (const r of (await query(CANONICAL_BAN_PLACERS_SQL, [c])).rows) if (r.placer) placers.add(r.placer);
    }
    placers.delete(actorId);
    if (placers.size === 0) return null;
    const { rows } = await query(ROLES_SQL, [[actorId, ...placers]]);
    const actorRank = roleRank(rows.find((r) => r.matrix_id === actorId));
    // The highest placer decides (and names the refusal).
    const bannerRank = Math.max(...[...placers].map((p) => roleRank(rows.find((r) => r.matrix_id === p))));
    if (!liftDenied({ bannerRank, actorRank })) return null;
    return new Response(`${WHO[bannerRank] ?? "A moderator"} placed this ban — only ${WHOM[bannerRank] ?? "a moderator"} can lift or change it.`, { status: 403 });
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }
}
