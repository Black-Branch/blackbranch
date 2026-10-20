import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireAdmin } from "@/app/lib/admin";

// Forum post pinning (site-only — see migrate-v36).
//   GET  /api/forum/pins?roomId=!room:example.org
//        → { pins: string[] }  (event ids, most-recently-pinned first) — public read
//   POST /api/forum/pins   { roomId, eventId, pinned: boolean }
//        → { pins: string[] } — admin only (site.users.is_admin)

function validRoomId(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("!") && s.length <= 256;
}
function validEventId(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("$") && s.length <= 256;
}

async function pinsFor(roomId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT event_id FROM site.forum_pins WHERE room_id = $1 ORDER BY pinned_at DESC`,
    [roomId]
  );
  return rows.map((r) => r.event_id as string);
}

export async function GET(req: NextRequest) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (!validRoomId(roomId)) return new Response("Bad Request", { status: 400 });
  try {
    return Response.json({ pins: await pinsFor(roomId) });
  } catch {
    return Response.json({ pins: [] });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => ({}));
  const { roomId, eventId, pinned } = body;
  if (!validRoomId(roomId) || !validEventId(eventId) || typeof pinned !== "boolean") {
    return new Response("Bad Request", { status: 400 });
  }

  if (pinned) {
    await pool.query(
      `INSERT INTO site.forum_pins (room_id, event_id, pinned_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_id, event_id) DO NOTHING`,
      [roomId, eventId, admin]
    );
  } else {
    await pool.query(
      `DELETE FROM site.forum_pins WHERE room_id = $1 AND event_id = $2`,
      [roomId, eventId]
    );
  }

  return Response.json({ pins: await pinsFor(roomId) });
}
