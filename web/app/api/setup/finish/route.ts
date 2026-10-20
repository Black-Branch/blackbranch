// Setup step 8. POST { quietHour, bugReports } — save them; when the staged display values differ
// from the running site's, ask the host to write them and restart the site (phase "applying"), else
// finish (phase "done"). POST { complete: true } — finish once the restarted site holds the values. GET — what is still
// pending, and the host's answer.
import { finishSetup, finishStatus } from "@/app/lib/setup/setupServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await finishSetup(req, body);
  return Response.json(r.body, { status: r.status });
}

export async function GET(req: Request) {
  const r = await finishStatus(req);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
