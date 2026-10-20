export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import pool from "@/lib/db";
import { forumReader, ForumReaderUnavailable } from "@/app/lib/forumReader";
import { loadForumJoins, applyJoins } from "@/app/lib/forumJoins";

// GET /api/forum/thread?room=!id&event=$id → { thread: { root, replies }, generatedAt }
// Public. The reader's thread (cached 60s) plus this viewer's joins on the
// root. 404 when the event is not a post of that room; 503 with no-store when
// the reader fails.
const validRoomId = (s: string | null): s is string => typeof s === "string" && s.startsWith("!") && s.length <= 256;
const validEventId = (s: string | null): s is string => typeof s === "string" && s.startsWith("$") && s.length <= 256;

function unavailable(e: unknown): Response {
  if (!(e instanceof ForumReaderUnavailable)) console.error("[forum] reader failed", e instanceof Error ? e.message : e);
  return Response.json({ error: "forums_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room");
  const event = req.nextUrl.searchParams.get("event");
  if (!validRoomId(room) || !validEventId(event)) return new Response("Bad Request", { status: 400 });
  let myId: string | null = null;
  try { myId = (await auth())?.user?.id ?? null; } catch { /* anon */ }
  try {
    const t = await forumReader.thread(room, event);
    if (!t) return new Response("Not Found", { status: 404 });
    const joins = await loadForumJoins(pool, [room], myId);
    return Response.json({ thread: { root: applyJoins(t.root, joins), replies: t.replies }, generatedAt: new Date().toISOString() });
  } catch (e) {
    return unavailable(e);
  }
}
