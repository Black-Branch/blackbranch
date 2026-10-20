export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { auth } from "@/auth";
import pool from "@/lib/db";
import { forumReader, ForumReaderUnavailable } from "@/app/lib/forumReader";
import { loadForumJoins, applyJoins } from "@/app/lib/forumJoins";
import { sortPostViews } from "@/app/lib/forumModel";
import type { PostSort } from "@/app/lib/matrixForum";

// GET /api/forum/posts?room=all|!id&sort=active|new|top → { rooms, posts, generatedAt }
// Public. The Matrix side comes from the service-account reader (cached 60s
// per room); scores, the caller's own votes and pins are joined per request.
// A reader failure is a 503 that carries no-store — never a 60s blank tab.
const SORTS = new Set<PostSort>(["active", "new", "top"]);
const validRoom = (s: string | null): s is string =>
  typeof s === "string" && (s === "all" || (s.startsWith("!") && s.length <= 256));

function unavailable(e: unknown): Response {
  if (!(e instanceof ForumReaderUnavailable)) console.error("[forum] reader failed", e instanceof Error ? e.message : e);
  return Response.json({ error: "forums_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const room = req.nextUrl.searchParams.get("room") ?? "all";
  const sortRaw = req.nextUrl.searchParams.get("sort") ?? "active";
  if (!validRoom(room)) return new Response("Bad Request", { status: 400 });
  const sort: PostSort = SORTS.has(sortRaw as PostSort) ? (sortRaw as PostSort) : "active";
  let myId: string | null = null;
  try { myId = (await auth())?.user?.id ?? null; } catch { /* anon */ }
  try {
    const rooms = await forumReader.rooms();
    const wanted = room === "all" ? rooms : rooms.filter((r) => r.roomId === room);
    const lists = await Promise.all(wanted.map((r) => forumReader.posts(r.roomId)));
    const joins = await loadForumJoins(pool, wanted.map((r) => r.roomId), myId);
    const posts = sortPostViews(lists.flat().map((p) => applyJoins(p, joins)), sort);
    return Response.json({ rooms, posts, generatedAt: new Date().toISOString() });
  } catch (e) {
    return unavailable(e);
  }
}
