// Per-request Postgres join for the forum routes: vote scores, the caller's own
// votes and admin pins for a set of rooms. The Matrix side is cached 60s in
// forumReader; this side is per request, so a vote shows the moment it lands
// and one viewer's votes never reach another's cache.
//
// `.ts` relative imports: node --test loads this module (dockState.ts says why).
import { mxcToHttp } from "./matrixMedia.ts";
import type { ReaderPost } from "./forumReader.ts";
import type { ForumPostView } from "./forumModel.ts";

type Pool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
export type ForumJoins = { scores: Map<string, number>; myVotes: Map<string, -1 | 1>; pins: Set<string> };

export async function loadForumJoins(pool: Pool, roomIds: readonly string[], myId: string | null): Promise<ForumJoins> {
  const joins: ForumJoins = { scores: new Map(), myVotes: new Map(), pins: new Set() };
  if (roomIds.length === 0) return joins;
  try {
    const ids = [...roomIds];
    const [scores, pins, mine] = await Promise.all([
      pool.query(`SELECT event_id, COALESCE(SUM(vote), 0)::int AS score FROM site.forum_votes WHERE room_id = ANY($1) GROUP BY event_id`, [ids]),
      pool.query(`SELECT event_id FROM site.forum_pins WHERE room_id = ANY($1)`, [ids]),
      myId
        ? pool.query(`SELECT event_id, vote FROM site.forum_votes WHERE room_id = ANY($1) AND voter_matrix_id = $2`, [ids, myId])
        : Promise.resolve({ rows: [] as unknown[] }),
    ]);
    for (const r of scores.rows as { event_id: string; score: number }[]) joins.scores.set(r.event_id, Number(r.score));
    for (const r of pins.rows as { event_id: string }[]) joins.pins.add(r.event_id);
    for (const r of mine.rows as { event_id: string; vote: number }[]) {
      if (r.vote === 1 || r.vote === -1) joins.myVotes.set(r.event_id, r.vote);
    }
  } catch { /* empty joins: the list still renders */ }
  return joins;
}

/** A reader post plus this viewer's joins, with the thumbnail routed through the media proxy. */
export function applyJoins(post: ReaderPost, joins: ForumJoins): ForumPostView {
  const { thumbnailMxc, ...rest } = post;
  return {
    ...rest,
    thumbnail: mxcToHttp(thumbnailMxc, 256),
    score: joins.scores.get(post.id) ?? 0,
    myVote: joins.myVotes.get(post.id) ?? null,
    pinned: joins.pins.has(post.id),
  };
}
