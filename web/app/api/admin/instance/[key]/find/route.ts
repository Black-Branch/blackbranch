import { type NextRequest } from "next/server";
import { requireAdminMutation, refindDerivedIds } from "@/app/lib/instanceAdminServer";
import { reloadInstanceConfig } from "@/app/lib/instanceConfigServer";
import { DERIVED_IDS } from "@/app/lib/derivedIds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/instance/<id key>/find — find a platform id again from its channel (Twitch's
// broadcaster id, Kick's user id, a Streamplace DID) and save it. ADMIN ONLY and SAME-ORIGIN ONLY
// (it spends a provider call), checked here. The answer names the id found, or why not.
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const key = decodeURIComponent((await params).key);
  const d = DERIVED_IDS[key];
  if (!d) return Response.json({ error: "not an id the site finds" }, { status: 404 });
  const found = (await refindDerivedIds(d.from, admin)).filter((f) => f.key === key);
  if (found.some((f) => f.ok)) await reloadInstanceConfig();
  return Response.json({ ok: true, found }, { headers: { "Cache-Control": "no-store" } });
}
