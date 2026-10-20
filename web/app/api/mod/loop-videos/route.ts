import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { parseYoutubeVideoId } from "@/app/lib/youtubeId";
import { reorderByPriority } from "@/app/lib/reorderPriority";
import { NextRequest } from "next/server";

// Community loop videos (mod only) — the playlist the community player loops
// when NOBODY is live. See migrations/migrate-v77.sql for why this list is
// global rather than per-featured-streamer.
//
//   GET    — the list, priority order
//   POST   — add:    { url, title? }  (a YouTube URL or a bare video id)
//   DELETE — remove: { id }
//   PATCH  — reorder: { order: number[] }

const TABLE = "site.community_loop_videos";

/** Titles are shown in the mod list only; keep them short and untrusted-safe. */
const MAX_TITLE = 200;

export async function GET() {
  const me = await requireMod();
  if (me instanceof Response) return me;
  const { rows } = await pool.query(
    `SELECT id, video_id, title, priority FROM ${TABLE} ORDER BY priority ASC`
  );
  return Response.json({ videos: rows });
}

export async function POST(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));
  const videoId = parseYoutubeVideoId(String(body.url ?? ""));
  if (!videoId) {
    return Response.json(
      { error: "Paste a YouTube link (watch, youtu.be, shorts or embed) or a bare video id" },
      { status: 400 }
    );
  }
  const title = String(body.title ?? "").trim().slice(0, MAX_TITLE) || null;

  // ON CONFLICT rather than a pre-check: the unique index on video_id is the
  // real guard, and a check-then-insert would race two mods adding at once.
  const { rows } = await pool.query(
    `INSERT INTO ${TABLE} (video_id, title, priority, added_by)
     VALUES ($1, $2, COALESCE((SELECT MAX(priority) FROM ${TABLE}), 0) + 1, $3)
     ON CONFLICT (video_id) DO NOTHING
     RETURNING id, video_id, title, priority`,
    [videoId, title, me]
  );
  if (rows.length === 0) {
    return Response.json({ error: "That video is already in the playlist" }, { status: 409 });
  }
  return Response.json(rows[0]);
}

export async function DELETE(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return Response.json({ error: "id (integer) required" }, { status: 400 });
  }
  const { rows } = await pool.query(
    `DELETE FROM ${TABLE} WHERE id = $1 RETURNING video_id`,
    [id]
  );
  if (rows.length === 0) {
    return Response.json({ error: `No loop video with id ${id}` }, { status: 404 });
  }
  return Response.json({ removed: rows[0].video_id });
}

export async function PATCH(req: NextRequest) {
  const me = await requireMod();
  if (me instanceof Response) return me;

  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body.order)) {
    return Response.json({ error: "order (array of ids) required" }, { status: 400 });
  }
  const ids = (body.order as unknown[]).map(Number).filter(Number.isInteger);
  if (ids.length === 0) {
    return Response.json({ error: "order must be a non-empty array of ids" }, { status: 400 });
  }

  await reorderByPriority(pool, TABLE, ids);

  const { rows } = await pool.query(
    `SELECT id, video_id, title, priority FROM ${TABLE} ORDER BY priority ASC`
  );
  return Response.json({ videos: rows });
}
