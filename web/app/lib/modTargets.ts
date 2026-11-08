// WHO a mod action lands on, for the privilege ceiling (modCeiling.ts), when the route is handed a
// thing rather than a person: a chat line (delete), a report (resolve), a suspicious mark (clear),
// a held line (automod resolve).
// Each answers the person the ceiling checks — a matrix id, or a canonical id it resolves itself —
// or null when the thing names nobody (an unknown id: there is nothing to act on).
//
// A failed read THROWS: the routes turn it into the ceiling's 503. Read as "nobody", an outage would
// let a mod act on an admin's line, or close a report about themselves.
//
// Dependency-free (relative imports only) so `node --test` can load it; the caller hands the query.

import { isNativePlatform } from "./nativePlatform.ts";
import { linkedMatrixIds, type LinkQuery } from "./canonicalIdentity.ts";

export type TargetQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const NUMERIC = /^[0-9]{1,18}$/;
const CANONICAL = /^[0-9a-f]{12}$/;

/** A chat line's id as the request gave it, normalised ONCE: a string of 1–18 digits, or a safe
 *  non-negative integer, as that digit string. Anything else (" 12", "12abc", 12.5, an object) is
 *  null — the route answers 400 — so the ceiling and the delete always act on the SAME value: a
 *  lenient reader on one side and a strict one on the other is how a check is skipped while the
 *  action still lands. */
export function normalizeMessageId(v: unknown): string | null {
  if (typeof v === "string") return NUMERIC.test(v) ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return null;
}

/** The author of a chat line (`id` from normalizeMessageId): a native line's site account, a
 *  platform line's canonical; null only when no such line exists. */
export async function messageAuthor(platform: string, id: string, query: TargetQuery): Promise<string | null> {
  if (!NUMERIC.test(id)) throw new Error("messageAuthor: the id was not normalised");
  if (isNativePlatform(platform)) {
    const { rows } = await query(`SELECT matrix_id FROM site.chat_messages WHERE id = $1`, [id]);
    return str(rows[0]?.matrix_id);
  }
  const { rows } = await query(`SELECT user_id FROM stream.chat_log WHERE id = $1`, [id]);
  return str(rows[0]?.user_id);
}

/** Who a report is about: the reported site account, else the reported platform-only chatter. */
export async function reportSubject(reportId: number, query: TargetQuery): Promise<string | null> {
  const { rows } = await query(`SELECT reported_id, reported_canonical_id FROM site.reports WHERE id = $1`, [reportId]);
  return str(rows[0]?.reported_id) ?? str(rows[0]?.reported_canonical_id);
}

/** Who a suspicious mark is on: the account it was put on, else the identity. */
export async function markSubject(markId: number, query: TargetQuery): Promise<string | null> {
  const { rows } = await query(`SELECT matrix_id, canonical_id FROM site.user_marks WHERE id = $1`, [markId]);
  return str(rows[0]?.matrix_id) ?? str(rows[0]?.canonical_id);
}

/** What a viewer of the Mod Panel's Reports is shown as the reporter when they are not an admin.
 *  @test-only exported so modCeilingRoutes.test.ts pins the exact word reportsForViewer writes. */
export const REPORTER_FOR_MODS = "a member";

type ReportRow = { reported_id: unknown; reported_canonical_id: unknown; reporter: unknown };

/**
 * The Reports list a viewer may see — THE RULE:
 *   • an admin sees every pending report, with the reporter's name;
 *   • a mod never sees a report ABOUT themselves — named by their site account or by a platform
 *     identity linked to it (canonicalIdentity.ts linkedMatrixIds): it would name who reported
 *     them, and it is not theirs to judge (resolving one is refused by the ceiling too);
 *   • a mod sees the reporter as "a member": acting on a report needs what was said and by whom it
 *     was said, not who complained, and a name invites retaliation. Admins handle a bad-faith
 *     reporter.
 * A failed identity read THROWS (the route answers 503) — never a list that may hold reports
 * about the viewer.
 */
export async function reportsForViewer<T extends ReportRow>(
  rows: T[], viewer: { id: string; admin: boolean }, query: TargetQuery,
): Promise<T[]> {
  if (viewer.admin) return rows;
  const about = aboutViewer(viewer.id, query);
  const out: T[] = [];
  for (const r of rows) {
    if (await about(r.reported_id, r.reported_canonical_id)) continue;
    out.push({ ...r, reporter: REPORTER_FOR_MODS });
  }
  return out;
}

/** The same rule for suspicious marks (GET /api/mod/marks): a mod never sees a mark ON themselves —
 *  by their account or a platform identity linked to it — or its evidence; an admin sees all.
 *  Throws on a failed identity read, like reportsForViewer. */
export async function marksForViewer<T extends { matrixId: string | null; canonicalId: string | null }>(
  rows: T[], viewer: { id: string; admin: boolean }, query: TargetQuery,
): Promise<T[]> {
  if (viewer.admin) return rows;
  const about = aboutViewer(viewer.id, query);
  const out: T[] = [];
  for (const r of rows) if (!(await about(r.matrixId, r.canonicalId))) out.push(r);
  return out;
}

/** Is a case (by its account, else its canonical) about this viewer? One answer per canonical. */
function aboutViewer(viewerId: string, query: TargetQuery): (account: unknown, canonical: unknown) => Promise<boolean> {
  const mine = new Map<string, boolean>();
  return async (account, canonical) => {
    if (account === viewerId) return true;
    const canon = str(canonical);
    if (!canon) return false;
    if (!mine.has(canon)) mine.set(canon, (await linkedMatrixIds(canon, query as LinkQuery)).includes(viewerId));
    return mine.get(canon) === true;
  };
}

/** Who a held line (site.automod_held) is by: the site account it was held for; for a Twitch AutoMod
 *  hold, the site line it is a cross-posted copy of, else the Twitch account's canonical; for our own
 *  platform holds, the canonical the row recorded. null = the row names nobody resolvable (an
 *  unknown row, or a Twitch chatter who never chatted here). */
export async function heldLineSubject(rowId: number, query: TargetQuery): Promise<string | null> {
  const { rows } = await query(
    `SELECT h.source, h.matrix_id, h.user_id, m.matrix_id AS copy_of
       FROM site.automod_held h LEFT JOIN site.chat_messages m ON m.id = h.site_msg_id
      WHERE h.id = $1`, [rowId]);
  const r = rows[0];
  if (!r) return null;
  const direct = str(r.matrix_id) ?? str(r.copy_of);
  if (direct) return direct;
  const uid = str(r.user_id);
  if (!uid) return null;
  if (r.source === "twitch") {
    const { rows: l } = await query(`SELECT canonical FROM stream.links WHERE platform = 'twitch' AND platform_id = $1`, [uid]);
    return str(l[0]?.canonical);
  }
  return CANONICAL.test(uid) ? uid : null;
}
