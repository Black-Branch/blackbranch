import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { streamApiFetch } from "@/app/lib/streamApi";
import { getActiveTier } from "@/app/lib/entitlements";
import { NextRequest } from "next/server";

// Start a cross-platform poll. Subscribers (any active tier, incl. gift subs)
// and mods/admins can start one; stream-api owns the poll itself (one active
// at a time — a 409 from it means a poll is already running).

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const { rows } = await pool.query<{ is_mod: boolean; is_admin: boolean; display_name: string | null }>(
    `SELECT is_mod, is_admin, display_name FROM site.users WHERE matrix_id = $1`,
    [matrixId]
  );
  const me = rows[0];
  const privileged = !!(me?.is_mod || me?.is_admin);
  if (!privileged && (await getActiveTier(matrixId)) == null) {
    return Response.json({ error: "subscribers_only" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });
  const question = typeof body.question === "string" ? body.question.trim().slice(0, 200) : "";
  const options = Array.isArray(body.options)
    ? body.options.map((o: unknown) => String(o ?? "").trim().slice(0, 100)).filter(Boolean).slice(0, 6)
    : [];
  const durationSec = Math.min(3600, Math.max(30, parseInt(String(body.durationSec), 10) || 120));
  if (!question || options.length < 2) {
    return Response.json({ error: "bad_poll" }, { status: 400 });
  }

  const res = await streamApiFetch("/poll/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      options,
      durationSec,
      createdBy: matrixId,
      createdByName: me?.display_name ?? matrixId,
    }),
  }).catch(() => null);
  if (!res) return Response.json({ error: "stream_api_down" }, { status: 502 });
  const data = await res.json().catch(() => ({}));
  return Response.json(data, { status: res.status });
}
