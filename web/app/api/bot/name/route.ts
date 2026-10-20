import { instanceString } from "@/app/lib/instanceConfigServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/bot/name — the bot's and the help desk's display name (instance key bot.name, a
// public value), for client components that show it. null = unset: the caller shows its own
// neutral fallback ("Bot", or "Help" for the help desk).
export async function GET() {
  const name = instanceString("bot.name");
  return Response.json({ name: name ?? null }, { headers: { "Cache-Control": "public, max-age=60" } });
}
