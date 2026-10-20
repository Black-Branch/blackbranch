// Suspicious marks. SERVER ONLY. Mods-only by construction: every route that calls this checks
// requireMod first, and nothing here reaches a public frame or route.
//
// A mark is OPENED by automod (stream-api automod.js) when a person has enough risky messages;
// its reason is fixed text, never model text. A mod CLEARS it here, with a mod_log row, so the
// usercard's existing action history shows both. A mark changes nothing about delivery.

import pool from "../../lib/db.ts";

export type MarkEvidence = { id: number; text: string; category: string | null; confidence: number | null; reason: string | null; status: string; platform: string | null; heldAt: string };
export type UserMark = {
  id: number; matrixId: string | null; canonicalId: string | null; platform: string | null; platformUser: string | null;
  reason: string; createdAt: string; evidence: MarkEvidence[];
};

type Row = { id: string; matrix_id: string | null; canonical_id: string | null; platform: string | null; platform_user: string | null; reason: string; created_at: Date; evidence: string[] };

async function withEvidence(rows: Row[], maxEvidence: number): Promise<UserMark[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.evidence || []).map(Number)))];
  const ev = ids.length
    ? (await pool.query<{ id: string; text: string; category: string | null; confidence: string | null; matched_term: string | null; status: string; platform: string | null; held_at: Date }>(
        `SELECT id, text, category, confidence, matched_term, status, platform, held_at FROM site.automod_held WHERE id = ANY($1::bigint[])`, [ids])).rows
    : [];
  const byId = new Map(ev.map((e) => [Number(e.id), e]));
  return rows.map((r) => ({
    id: Number(r.id), matrixId: r.matrix_id, canonicalId: r.canonical_id, platform: r.platform, platformUser: r.platform_user,
    reason: r.reason, createdAt: new Date(r.created_at).toISOString(),
    evidence: (r.evidence || []).map(Number).reverse().slice(0, maxEvidence).map((id) => byId.get(id)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => ({
      id: Number(e.id), text: e.text, category: e.category, confidence: e.confidence == null ? null : Number(e.confidence),
      reason: e.matched_term, status: e.status, platform: e.platform, heldAt: new Date(e.held_at).toISOString(),
    })),
  }));
}

/** Every open mark, newest first — the mod panel's list and the chat badge's set. */
export async function openMarks(limit = 100): Promise<UserMark[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, matrix_id, canonical_id, platform, platform_user, reason, created_at, evidence
       FROM site.user_marks WHERE cleared_at IS NULL ORDER BY created_at DESC LIMIT $1`, [limit]);
  return withEvidence(rows, 3);
}

/** The open mark on one person, by either of their ids (a site account's linked canonical too). */
export async function markOf({ matrixId, canonicalId }: { matrixId?: string | null; canonicalId?: string | null }): Promise<UserMark | null> {
  if (!matrixId && !canonicalId) return null;
  const { rows } = await pool.query<Row>(
    `SELECT m.id, m.matrix_id, m.canonical_id, m.platform, m.platform_user, m.reason, m.created_at, m.evidence
       FROM site.user_marks m
      WHERE m.cleared_at IS NULL AND (
            ($1::text IS NOT NULL AND m.matrix_id = $1)
         OR ($2::text IS NOT NULL AND m.canonical_id = $2)
         OR ($1::text IS NOT NULL AND m.canonical_id IN (SELECT canonical_id FROM site.platform_links WHERE matrix_id = $1)))
      ORDER BY m.created_at DESC LIMIT 1`,
    [matrixId ?? null, canonicalId ?? null]);
  return (await withEvidence(rows, 10))[0] ?? null;
}

/** Clear an open mark. Returns false when there was none (already cleared, or no such id). */
export async function clearMark(id: number, mod: string, note: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ subject: string }>(
      `UPDATE site.user_marks SET cleared_by = $2, cleared_at = now(), clear_note = $3
        WHERE id = $1 AND cleared_at IS NULL RETURNING COALESCE(canonical_id, matrix_id) AS subject`,
      [id, mod, note]);
    if (!r.rows[0]) { await client.query("ROLLBACK"); return false; }
    await client.query(
      `INSERT INTO site.mod_log (action, target_id, performed_by, reason) VALUES ('mark_cleared', $1, $2, $3)`,
      [r.rows[0].subject, mod, note]);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
