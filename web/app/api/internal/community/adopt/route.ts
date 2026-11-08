import pool from "@/lib/db";
import { adoptPostResponse } from "@/app/lib/community/adoptServer";
import { setupChannelsNow } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/community/adopt — the reconciler's adopt mode imports a room or space no row
// knows, or moves a row to its upgraded room (adoptServer.ts). The hub's import brings the channels
// the setup pages listed with it. Internal secret only; 401 otherwise.
export async function POST(req: Request) {
  return adoptPostResponse(req, { db: pool, secret: process.env.STREAM_API_SECRET, setup: setupChannelsNow });
}
