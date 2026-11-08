import { requireAdmin } from "@/app/lib/admin";
import { spotlightOff } from "@/app/lib/spotlightServer";

export const dynamic = "force-dynamic";

// GET → { on } — whether the streamer's highlight is switched on (Admin Panel › Site › Site ›
// Streamer highlight, #250). Only the admin's rows offer the click, so only an admin asks; it
// carries the switch, never the pick (clients learn the pick from the socket's connect frame).
export async function GET() {
  const me = await requireAdmin();
  if (!me) return new Response("Forbidden", { status: 403 });
  return Response.json({ on: !spotlightOff() }, { headers: { "Cache-Control": "no-store" } });
}
