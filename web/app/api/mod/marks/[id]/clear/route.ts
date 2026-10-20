import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { markSubject } from "@/app/lib/modTargets";
import { clearMark } from "@/app/lib/userMarks";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mod/marks/<id>/clear { note? } — a mod clears a suspicious mark (logged as
// mark_cleared in site.mod_log). MODS ONLY, checked here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOriginRequest(req.headers)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "bad id" }, { status: 400 });
  // Privilege ceiling on who the mark is on: a mod never clears their own mark or another mod's
  // (or the owner's) — an admin does. A failed read refuses (503).
  let subject: string | null;
  try {
    subject = await markSubject(id, (sql, params) => pool.query(sql, params));
  } catch {
    return Response.json({ error: "Moderation check unavailable — try again shortly" }, { status: 503, headers: { "Retry-After": "5" } });
  }
  if (subject) {
    const denied = await assertCanModerate(mod, subject, { selfCase: true });
    if (denied) return denied;
  }
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null;
  const ok = await clearMark(id, mod, note);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "no open mark with that id" }, { status: 404 });
}
