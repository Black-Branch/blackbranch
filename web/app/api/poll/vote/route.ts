import { streamApiFetch } from "@/app/lib/streamApi";
import { requireUser } from "@/app/lib/authGuard";
import { NextRequest } from "next/server";

// Vote on the active poll from the chat card. Any signed-in user; stream-api
// resolves the voter's canonical identity so a linked account can't double-vote
// from a platform chat too. Re-voting a different option moves the vote.

export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const optionN = parseInt(String(body?.optionN), 10);
  if (!Number.isFinite(optionN) || optionN < 1 || optionN > 6) {
    return Response.json({ error: "bad_option" }, { status: 400 });
  }

  const res = await streamApiFetch("/poll/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matrixId: matrixId, optionN }),
  }).catch(() => null);
  if (!res) return Response.json({ error: "stream_api_down" }, { status: 502 });
  const data = await res.json().catch(() => ({}));
  return Response.json(data, { status: res.status });
}
