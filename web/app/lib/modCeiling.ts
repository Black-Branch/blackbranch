// The mod privilege ceiling — free of pg/auth imports so it is unit testable;
// admin.ts hands it the pool. A non-admin mod must NOT perform a destructive
// moderation action (ban, timeout, purge, merge) against an admin (the owner) or
// another moderator or a Staff member (Staff is level 75, above Mod): only an admin acts on staff.
// Self-actions and platform-only targets (no resolvable matrix id — an unlinked
// chatter has no site account, so no role) are allowed — except a CASE about the
// actor (`selfCase`: resolving a report about yourself, clearing your own mark),
// which a non-admin mod leaves to another moderator.
// A canonical can stand for several accounts (its platform links plus the
// account whose own native canonical it is); EVERY one is checked, and one
// admin among them refuses.

import { ACCOUNT_CANONICALS_SQL, linkedMatrixIds } from "./canonicalIdentity.ts";

export type CeilingQuery = (
  sql: string, params: unknown[]
) => Promise<{ rows: { matrix_id: string; is_admin?: boolean; is_mod?: boolean; is_staff?: boolean }[] }>;

/** The role ladder, the community's levels: admin 100 · Staff 75 · mod 50 · everyone else 0.
 *  A person's rank is their highest role. modUnban.ts compares a ban's placer with the lifter. */
export function roleRank(r: { is_admin?: boolean | null; is_staff?: boolean | null; is_mod?: boolean | null } | null | undefined): number {
  if (r?.is_admin) return 100;
  if (r?.is_staff) return 75;
  if (r?.is_mod) return 50;
  return 0;
}

/** The pure decision, given resolved role flags. Called by checkModerationCeiling below.
 *  @test-only exported so modCeiling.test.ts can pin the truth table without a query. */
export function moderationCeilingDenied(o: {
  actorId: string;
  targetMx: string | null;
  actorAdmin: boolean;
  targetAdmin: boolean;
  targetMod?: boolean;
  targetStaff?: boolean;
}): boolean {
  if (!o.targetMx || o.targetMx === o.actorId) return false;
  return (o.targetAdmin || !!o.targetMod || !!o.targetStaff) && !o.actorAdmin;
}

/** 403 when the ceiling refuses, 503 when it cannot be decided, else null.
 *  Fails CLOSED: a failed lookup read as "no rows" would make the owner look like
 *  a non-admin or an unlinked chatter, and let the action through. */
export type CeilingOptions = {
  /** The action closes a case ABOUT the target (a report, a suspicious mark): a non-admin mod may
   *  not close one about themselves. Ordinary self-actions (deleting your own line) stay allowed. */
  selfCase?: boolean;
};

export async function checkModerationCeiling(
  actorId: string, target: string, query: CeilingQuery, opts: CeilingOptions = {},
): Promise<Response | null> {
  let targets: string[];
  let self = false;
  let rows: { matrix_id: string; is_admin?: boolean; is_mod?: boolean; is_staff?: boolean }[] = [];
  try {
    // The actor's own account among them is self; the others still count.
    const all = await linkedMatrixIds(target, query);
    self = all.includes(actorId);
    targets = all.filter((id) => id !== actorId);
    if (targets.length === 0 && !(opts.selfCase && self)) return null; // platform-only, or self
    ({ rows } = await query(
      `SELECT matrix_id, is_admin, is_mod, is_staff FROM site.users WHERE matrix_id = ANY($1)`,
      [[actorId, ...targets]],
    ));
  } catch {
    return new Response("Moderation check unavailable — try again shortly", {
      status: 503, headers: { "Retry-After": "5" },
    });
  }
  const actorAdmin = rows.find((r) => r.matrix_id === actorId)?.is_admin ?? false;
  if (opts.selfCase && self && !actorAdmin) {
    return new Response("Forbidden — a case about you goes to another moderator", { status: 403 });
  }
  for (const targetMx of targets) {
    const row = rows.find((r) => r.matrix_id === targetMx);
    const targetAdmin = row?.is_admin ?? false;
    const targetMod = row?.is_mod ?? false;
    const targetStaff = row?.is_staff ?? false;
    if (moderationCeilingDenied({ actorId, targetMx, actorAdmin, targetAdmin, targetMod, targetStaff })) {
      return new Response(targetAdmin
        ? "Forbidden — the owner cannot be moderated"
        : targetStaff
          ? "Only an admin can moderate a member of staff"
          : "Forbidden — only an admin can moderate a moderator", { status: 403 });
    }
  }
  return null;
}

/** The ceiling over every canonical an action on the ACCOUNT `matrixId` is also written onto (a ban,
 *  timeout or lift reaches the canonicals linked to it — community/accountBans.ts, unbans.ts,
 *  modTimeout.ts). Each canonical stands for every account linked to it, so one shared with a
 *  moderator's, Staff's or the owner's account is refused exactly as an action on that account is —
 *  checked BEFORE anything is written, so the account and its canonicals never part. Same answers
 *  as checkModerationCeiling: 403 refuses, 503 when undecidable (fails closed), null allows. */
export async function checkAccountCanonicalsCeiling(
  actorId: string, matrixId: string, query: CeilingQuery,
): Promise<Response | null> {
  let canonicals: string[];
  try {
    const { rows } = await query(`SELECT canonical AS matrix_id FROM ${ACCOUNT_CANONICALS_SQL}`, [matrixId]);
    canonicals = rows.map((r) => r.matrix_id).filter((c) => typeof c === "string" && c !== "");
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }
  for (const c of canonicals) {
    const denied = await checkModerationCeiling(actorId, c, query);
    if (denied) return denied;
  }
  return null;
}
