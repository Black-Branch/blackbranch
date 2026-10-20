// POST /api/setup/test — a module setup page's Test button ({ key }): the credential's own check,
// run where the credential is used. Admin only; only keys on a switched-on module's setup page.
import { setupTest } from "@/app/lib/setup/setupServer";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await setupTest(req, body);
  return Response.json(r.body, { status: r.status });
}
