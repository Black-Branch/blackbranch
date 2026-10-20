// POST /api/setup/admin — setup step 1: the setup link's token makes the first admin through the
// homeserver's account server. { token, username, password } → { ok, matrixId }; the page then
// signs the person in through the normal sign-in. Refused once any admin exists.
import { createFirstAdmin } from "@/app/lib/setup/setupServer";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await createFirstAdmin(req, body);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
