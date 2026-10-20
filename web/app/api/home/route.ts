export const dynamic = "force-dynamic";

import { getHomePayload } from "@/app/lib/homeCache";

// GET /api/home → HomePayload. Public. The body comes from the cache the server
// render of `/` shares (homeCache.ts says how it is built and why it is one).
export async function GET() {
  return Response.json(await getHomePayload());
}
