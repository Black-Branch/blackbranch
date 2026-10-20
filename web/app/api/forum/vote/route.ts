import { auth } from "@/auth";
import pool from "@/lib/db";
import { getMatrixSession, RevokedSessionError } from "@/app/lib/matrixSession";
import { resolveIdentities } from "@/lib/socialCredit";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { forumReader, ForumReaderUnavailable } from "@/app/lib/forumReader";
import { NextRequest } from "next/server";

// Forum voting (site-only — see migrate-v37). Votes on posts AND comments
// feed the social-credit system (web/lib/socialCredit.ts).
//   GET  /api/forum/vote?roomId=!room:example.org
//        → { scores: { [eventId]: number }, myVotes: { [eventId]: -1 | 1 } }
//          (scores public; myVotes only for the signed-in caller) — public read
//   POST /api/forum/vote  { roomId, eventId, vote: -1 | 0 | 1 }
//        → { score, myVote }  (0 clears) — auth required
//
// Who wrote the post decides whose social credit the vote moves, so the author
// is never taken from the client, and never from the voter's homeserver either:
// a viewer signed in from a homeserver they run could answer any event id with
// any `sender` — someone on ours to cost them credit, or themselves to farm it.
// The author comes from the forum reader alone: OUR homeserver, the reader's
// service token, and only for a room the reader discovered as a forum. An event
// the reader cannot find in such a room is refused.

function validRoomId(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("!") && s.length <= 256;
}
function validEventId(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("$") && s.length <= 256;
}

// 20 votes per 60s per user — looser than live chat (a forum browse session
// votes more in bursts) but still farm-resistant.
const isRateLimited = createSlidingWindowLimiter(60_000, 20);

export async function GET(req: NextRequest) {
  const roomId = req.nextUrl.searchParams.get("roomId");
  if (!validRoomId(roomId)) return new Response("Bad Request", { status: 400 });

  let myId: string | null = null;
  try { myId = (await auth())?.user?.id ?? null; } catch { /* anon read */ }

  try {
    const { rows } = await pool.query(
      `SELECT event_id, COALESCE(SUM(vote), 0)::int AS score
       FROM site.forum_votes WHERE room_id = $1 GROUP BY event_id`,
      [roomId]
    );
    const scores: Record<string, number> = {};
    for (const r of rows) scores[r.event_id as string] = r.score as number;

    const myVotes: Record<string, number> = {};
    if (myId) {
      const mine = await pool.query(
        `SELECT event_id, vote FROM site.forum_votes WHERE room_id = $1 AND voter_matrix_id = $2`,
        [roomId, myId]
      );
      for (const r of mine.rows) myVotes[r.event_id as string] = r.vote as number;
    }
    return Response.json({ scores, myVotes });
  } catch {
    return Response.json({ scores: {}, myVotes: {} });
  }
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await getMatrixSession();
  } catch (e) {
    if (e instanceof RevokedSessionError) return Response.json({ error: "revoked" }, { status: 401 });
    throw e;
  }
  if (!session) return new Response("Unauthorized", { status: 401 });

  if (isRateLimited(session.matrixId)) return new Response("Too Many Requests", { status: 429 });

  const body = await req.json().catch(() => ({}));
  const { roomId, eventId, vote } = body;
  if (!validRoomId(roomId) || !validEventId(eventId) || ![-1, 0, 1].includes(vote)) {
    return new Response("Bad Request", { status: 400 });
  }

  // The reader answers only for a discovered forum room (null otherwise, and
  // for an event it cannot see there), with its own deadline.
  let author: string | null;
  try {
    author = await forumReader.sender(roomId, eventId);
  } catch (e) {
    if (e instanceof ForumReaderUnavailable) return new Response("Service Unavailable", { status: 503 });
    return new Response("Bad Gateway", { status: 502 });
  }
  if (!author) return new Response("Not Found", { status: 404 });

  // Reddit-style auto-upvote: your own content carries a single, immutable +1.
  // Recorded (so it counts in social credit) but never downgradable or
  // removable — re-calls are idempotent. Covers linked identities too.
  const me = await resolveIdentities({ matrixId: session.matrixId });
  const isSelf = author === session.matrixId || me.matrixIds.includes(author);
  if (isSelf) {
    await pool.query(
      `INSERT INTO site.forum_votes (room_id, event_id, voter_matrix_id, author_matrix_id, vote)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (room_id, event_id, voter_matrix_id) DO NOTHING`,
      [roomId, eventId, session.matrixId, author]
    );
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(vote), 0)::int AS score FROM site.forum_votes WHERE room_id = $1 AND event_id = $2`,
      [roomId, eventId]
    );
    return Response.json({ score: rows[0].score as number, myVote: 1, self: true });
  }

  if (vote === 0) {
    await pool.query(
      `DELETE FROM site.forum_votes WHERE room_id = $1 AND event_id = $2 AND voter_matrix_id = $3`,
      [roomId, eventId, session.matrixId]
    );
  } else {
    await pool.query(
      `INSERT INTO site.forum_votes (room_id, event_id, voter_matrix_id, author_matrix_id, vote)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, event_id, voter_matrix_id)
       DO UPDATE SET vote = EXCLUDED.vote, author_matrix_id = EXCLUDED.author_matrix_id, created_at = now()`,
      [roomId, eventId, session.matrixId, author, vote]
    );
  }

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(vote), 0)::int AS score
     FROM site.forum_votes WHERE room_id = $1 AND event_id = $2`,
    [roomId, eventId]
  );
  return Response.json({ score: rows[0].score as number, myVote: vote === 0 ? null : vote });
}
