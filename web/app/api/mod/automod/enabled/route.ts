import { requireMod } from "@/app/lib/admin";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";
import { writeInstanceValue } from "@/app/lib/instanceAdminServer";
import { reloadInstanceConfig } from "@/app/lib/instanceConfigServer";
import { appendModLog } from "@/app/lib/modlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mod/automod/enabled { on: boolean } — the Mod Panel's AI automod switch. MOD-gated and
// same-origin. It writes the one switch `automod.enabled` through the same writer the Admin Panel
// uses (stream-api stores it) and logs who flipped it. Nothing else of automod's settings is
// reachable here — those are the Admin Panel's (AI → Automod).
export async function POST(req: Request) {
  if (!sameOriginRequest(req.headers)) return Response.json({ error: "cross-site request refused" }, { status: 403 });
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  const body = (await req.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return Response.json({ error: "on must be true or false" }, { status: 400 });
  const r = await writeInstanceValue("automod.enabled", body.on, mod);
  if (r.status !== 200) return Response.json(r.body, { status: r.status });
  await reloadInstanceConfig();
  await appendModLog({ action: body.on ? "automod_enabled" : "automod_disabled", target: "site", by: mod });
  return Response.json({ ok: true, on: body.on });
}
