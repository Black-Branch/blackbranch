import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { requestHost, hostRequestsAvailable } from "@/app/lib/hostRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/restart { service: "stream-api" | "stream-ingest" } — the Modules card's Restart
// button: a module switch the chat or ingest service reads applies when that
// service restarts. ADMIN ONLY, same-origin. On a bundle install the host is asked through the
// fixed verbs `blackbranch` already accepts (restart-stream-api / restart-stream-ingest); anywhere
// else there is no host to ask, and the answer says so (409).
const VERB = { "stream-api": "restart-stream-api", "stream-ingest": "restart-stream-ingest" } as const;

export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => null)) as { service?: unknown } | null;
  const service = typeof body?.service === "string" ? body.service : "";
  if (!(service in VERB)) return Response.json({ error: "service must be stream-api or stream-ingest" }, { status: 400 });
  if (!hostRequestsAvailable()) return Response.json({ error: "this install cannot restart its services from the site; restart it on the server" }, { status: 409 });
  const r = await requestHost(VERB[service as keyof typeof VERB]);
  if (!r.ok) return Response.json({ error: r.error }, { status: 502 });
  return Response.json({ requested: true, requestedAt: r.requestedAt });
}
