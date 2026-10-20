import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { streamApiFetch } from "@/app/lib/streamApi";
import { sameOriginRequest } from "@/app/lib/instanceAdminView";
import { NextRequest } from "next/server";

// The viewer's own "Let the bot remember my messages" (site.memory_opt_outs, v138).
// GET → { remember }. PUT { remember } → stream-api memory.js, the table's one
// writer: turning it off forgets what the bot already holds, in the same call.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const { rows } = await pool.query(`SELECT 1 FROM site.memory_opt_outs WHERE matrix_id = $1`, [matrixId]);
  return Response.json({ remember: rows.length === 0 }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  if (!sameOriginRequest(req.headers)) return new Response("cross-site request refused", { status: 403 });
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = (await req.json().catch(() => null)) as { remember?: unknown } | null;
  if (typeof body?.remember !== "boolean") return new Response("remember:boolean required", { status: 400 });

  const res = await streamApiFetch("/memory/opt-out", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matrixId, optedOut: !body.remember }),
  }).catch(() => null);
  if (!res?.ok) return new Response("Couldn't save — try again", { status: 502 });
  const d = (await res.json().catch(() => ({}))) as { optedOut?: boolean; deleted?: number };
  return Response.json({ remember: d.optedOut === false, forgotten: Number(d.deleted) || 0 });
}
