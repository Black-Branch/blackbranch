import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { heldStateOf } from "@/app/lib/heldMessages";

// GET /api/chat/held/<site.automod_held id> — the sender's own view of a message
// that was held for review. Polled by the sender's pending line every 10 s
// while it is visible.
//
// Sender only. A row that is not the session's own answers 404, exactly like a
// row that does not exist, so the endpoint cannot be walked to learn which ids are
// held or by whom. It never returns the text (the sender already has it).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new Response("Not Found", { status: 404 });

  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM site.automod_held WHERE id = $1 AND matrix_id = $2`,
    [id, matrixId],
  );
  if (!rows[0]) return new Response("Not Found", { status: 404 });
  return Response.json({ state: heldStateOf(rows[0].status) }, { headers: { "Cache-Control": "no-store" } });
}
