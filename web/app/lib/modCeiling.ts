// The mod privilege ceiling — free of pg/auth imports so it is unit testable;
// admin.ts hands it the pool. A non-admin mod must NOT perform a destructive
// moderation action (ban, timeout, purge, merge) against an admin (the owner) or
// another moderator: only an admin acts on staff.
// Self-actions and platform-only targets (no resolvable matrix id — an unlinked
// chatter has no site account, so no role) are allowed — except a CASE about the
// actor (`selfCase`: resolving a report about yourself, clearing your own mark),
// which a non-admin mod leaves to another moderator.
// A canonical can stand for several accounts (its platform links plus the
// account whose own native canonical it is); EVERY one is checked, and one
// admin among them refuses.

import { linkedMatrixIds } from "./canonicalIdentity.ts";

export type CeilingQuery = (
  sql: string, params: unknown[]
) => Promise<{ rows: { matrix_id: string; is_admin?: boolean; is_mod?: boolean }[] }>;

/** The pure decision, given resolved role flags. Called by checkModerationCeiling below.
 *  @test-only exported so modCeiling.test.ts can pin the truth table without a query. */
export function moderationCeilingDenied(o: {
  actorId: string;
  targetMx: string | null;
  actorAdmin: boolean;
  targetAdmin: boolean;
  targetMod?: boolean;
}): boolean {
  if (!o.targetMx || o.targetMx === o.actorId) return false;
  return (o.targetAdmin || !!o.targetMod) && !o.actorAdmin;
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
  let rows: { matrix_id: string; is_admin?: boolean; is_mod?: boolean }[] = [];
  try {
    // The actor's own account among them is self; the others still count.
    const all = await linkedMatrixIds(target, query);
    self = all.includes(actorId);
    targets = all.filter((id) => id !== actorId);
    if (targets.length === 0 && !(opts.selfCase && self)) return null; // platform-only, or self
    ({ rows } = await query(
      `SELECT matrix_id, is_admin, is_mod FROM site.users WHERE matrix_id = ANY($1)`,
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
    if (moderationCeilingDenied({ actorId, targetMx, actorAdmin, targetAdmin, targetMod })) {
      return new Response(targetAdmin
        ? "Forbidden — the owner cannot be moderated"
        : "Forbidden — only an admin can moderate a moderator", { status: 403 });
    }
  }
  return null;
}
