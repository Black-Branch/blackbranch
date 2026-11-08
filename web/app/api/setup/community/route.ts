// Setup step 7. POST { federation, registration, channels? } — save the switch, the sign-up answer
// and the channels listed beyond #general and #forum (made after setup), then ask the host to make
// the community (the space, #general and #forum, as the first admin's own account); GET — the rooms
// once recorded, and the host's answer.
import { communityStatus, startCommunity } from "@/app/lib/setup/setupServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await startCommunity(req, body);
  return Response.json(r.body, { status: r.status });
}

export async function GET(req: Request) {
  const r = await communityStatus(req);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
