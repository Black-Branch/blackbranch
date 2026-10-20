// POST /api/setup/step — save one setup page and move to the next ({ step, data }), or go back
// ({ goto }). Admin only, same-origin only; every value is checked again on the server.
import { saveStep } from "@/app/lib/setup/setupServer";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await saveStep(req, body);
  return Response.json(r.body, { status: r.status });
}
