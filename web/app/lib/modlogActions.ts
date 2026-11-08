// The mod-log rows of three case-closing actions, one builder each so the routes and the tests share
// the exact row. The routes append them only after their own write took effect.
import type { ModLogEntry } from "./modlog.ts";

/** Identity links: `victim` was merged into `survivor`. The victim's record is gone afterwards, so
 *  its name and id ride in the reason. */
export function identityMergedEntry(o: { mod: string; survivor: string; victim: { userId: string; name: string | null } }): ModLogEntry {
  const who = o.victim.name ? `${o.victim.name} (${o.victim.userId})` : o.victim.userId;
  return { action: "identity_merged", target: o.survivor, by: o.mod, reason: `merged in ${who}` };
}

/** A pending report closed; `subject` is who it was about (an account or a platform identity). */
export function reportResolvedEntry(o: { mod: string; subject: string; reportId: number }): ModLogEntry {
  return { action: "report_resolved", target: o.subject, by: o.mod, reason: `report #${o.reportId}` };
}

/** A held line posted to chat by a mod's Allow; `source` is what held it. */
export function heldReleasedEntry(o: { mod: string; sender: string; source: string; rowId: number }): ModLogEntry {
  return { action: "held_released", target: o.sender, by: o.mod, reason: `held by ${o.source} · #${o.rowId}` };
}
