// GET /api/setup/status — public: is this site still being set up? { state: "complete" |
// "setting-up" | "unknown" }. proxy.ts reads it to gate every page (app/lib/setup/setupGate.ts);
// "unknown" (the settings have not loaded) fails open.
import { setupStatus } from "@/app/lib/setup/setupServer";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ state: setupStatus() }, { headers: { "Cache-Control": "no-store" } });
}
