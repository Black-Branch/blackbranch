// WHO a mod action lands on, for the privilege ceiling (modCeiling.ts), when the route is handed a
// thing rather than a person: a chat line (delete), a report (resolve), a suspicious mark (clear).
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
 * The Reports list a viewer may see — THE RULE (round 5):
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
  const mine = new Map<string, boolean>();
  const out: T[] = [];
  for (const r of rows) {
    if (r.reported_id === viewer.id) continue;
    const canon = str(r.reported_canonical_id);
    if (canon) {
      if (!mine.has(canon)) {
        mine.set(canon, (await linkedMatrixIds(canon, query as LinkQuery)).includes(viewer.id));
      }
      if (mine.get(canon)) continue;
    }
    out.push({ ...r, reporter: REPORTER_FOR_MODS });
  }
  return out;
}
