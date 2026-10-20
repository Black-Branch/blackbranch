import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { streamApiFetch } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";

// End / cancel / extend the active poll. Mods and admins always can (the
// override); the poll's creator can end or cancel their own early.

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const action = body?.action === "cancel" ? "cancel" : body?.action === "extend" ? "extend" : "end";
  const addSec = action === "extend" ? Math.min(3600, Math.max(10, parseInt(String(body?.addSec), 10) || 60)) : undefined;

  const { rows } = await pool.query<{ is_mod: boolean; is_admin: boolean }>(
    `SELECT is_mod, is_admin FROM site.users WHERE matrix_id = $1`,
    [matrixId]
  );
  const privileged = !!(rows[0]?.is_mod || rows[0]?.is_admin);
  if (!privileged) {
    // Creators may end/cancel their own poll early, but not extend it —
    // stretching a running poll is a moderation call.
    if (action === "extend") return Response.json({ error: "mods_only" }, { status: 403 });
    const cRes = await streamApiFetch("/poll/creator").catch(() => null);
    const creator = cRes ? (await cRes.json().catch(() => ({})))?.createdBy : null;
    if (!creator || creator !== matrixId) {
      return Response.json({ error: "not_your_poll" }, { status: 403 });
    }
  }

  const res = await streamApiFetch("/poll/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, addSec, endedBy: matrixId }),
  }).catch(() => null);
  if (!res) return Response.json({ error: "stream_api_down" }, { status: 502 });
  const data = await res.json().catch(() => ({}));
  return Response.json(data, { status: res.status });
}
