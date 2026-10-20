// GET /api/setup/recovery — setup step 2: the backup passphrase and where .env lives, for the
// signed-in admin, while the recovery sheet is the current step. Shown once.
import { recoverySheet } from "@/app/lib/setup/setupServer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const r = await recoverySheet(req);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
