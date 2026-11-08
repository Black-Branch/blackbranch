import pool from "@/lib/db";
import { desiredFeedResponse, feedEnv } from "@/app/lib/community/desiredServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/internal/community/desired — the community reconciler's input (desiredServer.ts).
// Internal secret only; 401 otherwise.
export async function GET(req: Request) {
  return desiredFeedResponse(req, { db: pool, secret: process.env.STREAM_API_SECRET, env: feedEnv });
}
