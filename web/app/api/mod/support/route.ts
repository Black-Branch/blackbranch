import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { reportSubject, reportsForViewer } from "@/app/lib/modTargets";
import { NATIVE_SQL } from "@/app/lib/nativePlatform";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Open tickets (site.support_tickets, v92; the Admin Panel's Support tickets — ADMINS only: a
// help-desk ticket carries a viewer's own words and transcript, and only the Admin Panel shows
// them) + pending reports (site.reports; the Mod Panel's Reports, mod scope). A report names a site
// account or, since v155, a platform-only chatter by canonical id, and the message it was filed
// from — whose text is read here so the mod sees what was reported. What a mod is shown of the
// reports (none about themselves, no reporter name) is modTargets.ts reportsForViewer's rule.
// Resolution stamps who resolved, and is held to the moderation ceiling.

const unavailable = () =>
  new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });

async function isAdminId(id: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_admin: boolean }>(`SELECT is_admin FROM site.users WHERE matrix_id = $1`, [id]);
  return rows[0]?.is_admin === true;
}

export async function GET() {
  const modId = await requireMod();
  if (typeof modId !== "string") return modId;

  let admin: boolean;
  try { admin = await isAdminId(modId); } catch { return unavailable(); }
  const [tickets, reports] = await Promise.all([
    admin ? pool.query(
      `SELECT t.id, t.kind, t.body, t.transcript, t.created_at,
              COALESCE(u.display_name, t.matrix_id) AS who
       FROM site.support_tickets t
       LEFT JOIN site.users u ON u.matrix_id = t.matrix_id
       WHERE t.status = 'open'
       ORDER BY t.created_at DESC
       LIMIT 100`
    ) : Promise.resolve({ rows: [] }),
    pool.query(
      `SELECT r.id, r.reason, r.created_at, r.reported_id, r.reported_canonical_id,
              r.message_platform, r.message_id,
              COALESCE(ru.display_name, r.reported_id,
                       (SELECT NULLIF(su.name, '') FROM stream.users su WHERE su.id = r.reported_canonical_id),
                       r.reported_canonical_id) AS reported,
              COALESCE(pu.display_name, r.reporter_id) AS reporter,
              COALESCE(cm.message, cl.message) AS message_text
       FROM site.reports r
       LEFT JOIN site.users ru ON ru.matrix_id = r.reported_id
       LEFT JOIN site.users pu ON pu.matrix_id = r.reporter_id
       LEFT JOIN site.chat_messages cm
              ON r.message_platform IN ${NATIVE_SQL} AND r.message_id ~ '^[0-9]+$' AND cm.id = r.message_id::bigint
       LEFT JOIN stream.chat_log cl
              ON r.message_platform NOT IN ${NATIVE_SQL} AND r.message_id ~ '^[0-9]+$' AND cl.id = r.message_id::bigint
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC
       LIMIT 100`
    ),
  ]);
  let shown;
  try {
    shown = await reportsForViewer(reports.rows, { id: modId, admin }, (sql, params) => pool.query(sql, params));
  } catch {
    return unavailable();
  }
  return Response.json({ tickets: tickets.rows, reports: shown });
}

// POST { kind: "ticket"|"report", id } → resolve it.
export async function POST(req: NextRequest) {
  const modId = await requireMod();
  if (typeof modId !== "string") return modId;

  const body = (await req.json().catch(() => null)) as { kind?: unknown; id?: unknown } | null;
  const id = Number(body?.id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad Request", { status: 400 });

  // Who may close it, before anything is written.
  if (body?.kind === "ticket") {
    // Tickets are the Admin Panel's (see GET).
    let admin: boolean;
    try { admin = await isAdminId(modId); } catch { return unavailable(); }
    if (!admin) return new Response("Forbidden", { status: 403 });
  } else if (body?.kind === "report") {
    // Privilege ceiling on who the report is ABOUT: a mod never closes one about themselves, another
    // mod or the owner — an admin does. An unknown report names nobody (the UPDATE matches nothing).
    let subject: string | null;
    try { subject = await reportSubject(id, (sql, params) => pool.query(sql, params)); } catch { return unavailable(); }
    if (subject) {
      const denied = await assertCanModerate(modId, subject, { selfCase: true });
      if (denied) return denied;
    }
  } else {
    return new Response("Bad Request", { status: 400 });
  }

  if (body?.kind === "ticket") {
    await pool.query(
      `UPDATE site.support_tickets
       SET status = 'resolved', resolved_at = now(), resolved_by = $2
       WHERE id = $1 AND status = 'open'`,
      [id, modId]
    );
  } else {
    await pool.query(
      `UPDATE site.reports SET status = 'resolved', resolved_at = now(), resolved_by = $2
       WHERE id = $1 AND status = 'pending'`,
      [id, modId]
    );
  }
  return Response.json({ ok: true });
}
