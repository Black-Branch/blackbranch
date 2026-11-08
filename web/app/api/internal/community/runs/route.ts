import pool from "@/lib/db";
import { runPostResponse } from "@/app/lib/community/desiredServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/community/runs — the reconciler's run log (desiredServer.ts). Internal secret
// only; 401 otherwise.
export async function POST(req: Request) {
  return runPostResponse(req, { db: pool, secret: process.env.STREAM_API_SECRET });
}
