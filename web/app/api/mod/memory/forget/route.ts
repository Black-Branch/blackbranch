import { requireAdmin } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";
import { NextRequest } from "next/server";

// POST { matrixId } | { canonicalId } — admin only: "Forget this person's AI memory"
// from the usercard. stream-api (memory.js) resolves every identity linked to the
// one given, deletes their message embeddings plus whatever per-person memory the
// bot plugin keeps — on this admin path also shared lore entries naming them — and
// writes site.mod_log 'memory_forget'. Idempotent. This is how an emailed "forget
// me" request is answered in one click.
export async function POST(req: NextRequest) {
  if (!sameOriginRequest(req.headers)) return new Response("cross-site request refused", { status: 403 });
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = (await req.json().catch(() => null)) as { matrixId?: unknown; canonicalId?: unknown; dryRun?: unknown } | null;
  // dryRun: the counts the confirm shows before anything is removed.
  const dryRun = body?.dryRun === true;
  const matrixId = typeof body?.matrixId === "string" && body.matrixId.trim() ? body.matrixId.trim() : null;
  const canonicalId = typeof body?.canonicalId === "string" && body.canonicalId.trim() ? body.canonicalId.trim() : null;
  if (!matrixId && !canonicalId) return new Response("matrixId or canonicalId required", { status: 400 });

  const res = await streamApiFetch("/memory/forget", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(matrixId ? { matrixId } : { canonicalId }), actor: admin, dryRun }),
  }).catch(() => null);
  if (!res?.ok) return new Response("Forget failed — nothing was removed", { status: 502 });
  const d = (await res.json().catch(() => ({}))) as { deleted?: number; byHandler?: Record<string, { lore?: number }> };
  const lore = Object.values(d.byHandler ?? {}).reduce((n, h) => n + (Number(h?.lore) || 0), 0);
  return Response.json({ ok: true, dryRun, deleted: Number(d.deleted) || 0, lore });
}
