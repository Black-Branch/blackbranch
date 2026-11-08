import pool from "@/lib/db";
import { madePostResponse } from "@/app/lib/community/desiredServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/internal/community/made — the reconciler records a room it made on its row
// (desiredServer.ts). Internal secret only; 401 otherwise.
export async function POST(req: Request) {
  return madePostResponse(req, { db: pool, secret: process.env.STREAM_API_SECRET });
}
