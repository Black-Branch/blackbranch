// Which stream is happening right now, for per-stream earn accounting.
//
// null when nothing is live, and every caller must treat that as "no award"
// — never as "use the last one". Awarding against a finished stream would let a
// viewer collect the first-message bonus again the moment a stream ends, and
// keep earning against a stream that is over.
//
// Cached for a few seconds: a busy chat would otherwise run this query once per
// message. The TTL is short enough that the first award of a stream lands
// within seconds of it starting.
//
// Relative imports carry `.ts` because node --test loads this module directly
// and does not understand the tsconfig "@/*" alias.
import type { Pool } from "pg";
import pool from "../../lib/db.ts";

/** @test-only the cache window is internal to this module; it is exported so
 *  the tests can advance a fake clock to exactly the boundary rather than
 *  restating 15s by hand and drifting from it. */
export const STREAM_ID_TTL_MS = 15_000;

/** @parked consumed by the production singleton below and by
 *  currentStream.test.ts; exported so the tests can drive a fake pool and a
 *  fake clock, the same shape as createStorePricing. */
export function createCurrentStream(deps: { pool: Pool; nowMs: () => number }) {
  let cached: { id: number | null; at: number } | null = null;

  async function currentStreamId(): Promise<number | null> {
    const now = deps.nowMs();
    if (cached && now - cached.at < STREAM_ID_TTL_MS) return cached.id;

    try {
      // ended_at IS NULL is the live session. ORDER BY + LIMIT 1 because a
      // crashed ingest can leave an older session unclosed; the newest open one
      // is the one people are watching.
      const { rows } = await deps.pool.query<{ stream_id: string }>(
        `SELECT stream_id FROM stream.sessions
          WHERE ended_at IS NULL
          ORDER BY started_at DESC
          LIMIT 1`
      );
      const id = rows[0] ? Number(rows[0].stream_id) : null;
      cached = { id, at: now };
      return id;
    } catch {
      // Read as offline, and do NOT cache it. Every caller sits on a
      // fire-and-forget earn path that must never break the action it rewards,
      // so throwing is wrong — but pinning "offline" for the whole TTL on one
      // blip would cost real awards, so the next call tries again.
      return null;
    }
  }

  return { currentStreamId };
}

/** Production singleton, the same pattern as `storePricing`.
 *  Consumed by coinsServer.ts's earn paths. */
export const currentStream = createCurrentStream({ pool, nowMs: () => Date.now() });
