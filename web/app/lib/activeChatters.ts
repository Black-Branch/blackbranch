// How many distinct people have said something recently.
//
// The auto-pin threshold scales with active chatters, so a pin at a few
// points does not come too cheaply on a busy stream; it is the only caller —
// see `autoPinScore` in votePolicy.ts for the measured curve and why it steps
// rather than multiplies.
//
// CHATTERS, NOT VIEWERS. `stream.viewer_snapshots` already exists and is the
// tempting shortcut, but it counts people WATCHING — which is an order of
// magnitude larger and moves for reasons that have nothing to do with how many
// hands are available to upvote. The threshold is about the size of the voting
// crowd, so it has to be measured from the crowd that speaks.
//
// null means UNKNOWN, and every caller must treat it as such rather than as
// zero — same contract as currentStreamId. A failed query must not silently
// become "nobody is here", which would pin the threshold at its most permissive
// for a reason nobody can see.
//
// Cached, because chat is the caller: without it every vote on a busy stream
// runs a COUNT(DISTINCT) over the window. The count moves slowly by nature —
// people do not join and leave a conversation second by second — so the TTL can
// be far longer than currentStream's without ever being noticeably stale.
//
// Relative imports carry `.ts` because node --test loads this module directly
// and does not understand the tsconfig "@/*" alias.
import type { Pool } from "pg";
import pool from "../../lib/db.ts";

/** @test-only exported so the tests can advance a fake clock to exactly the
 *  boundary rather than restating 60s by hand and drifting from it. */
export const ACTIVE_CHATTERS_TTL_MS = 60_000;

/**
 * The window "recently" means. 15 minutes matches the bucket the auto-pin curve
 * was measured over — the number and the measurement have to agree, or the
 * curve is calibrated against a different quantity than the one it is fed.
 *
 * Deliberately NOT exported: it is interpolated straight into SQL below, and an
 * exported knob invites a caller to pass a window the curve was never measured
 * against (and, being a string in a query, to pass something worse).
 */
const ACTIVE_CHATTERS_WINDOW = "15 minutes";

/** @parked consumed by the production singleton below and by
 *  activeChatters.test.ts; exported so the tests can drive a fake pool and a
 *  fake clock, the same shape as createCurrentStream/createStorePricing. */
export function createActiveChatters(deps: { pool: Pool; nowMs: () => number }) {
  let cached: { n: number | null; at: number } | null = null;

  async function activeChatters(): Promise<number | null> {
    const now = deps.nowMs();
    if (cached && now - cached.at < ACTIVE_CHATTERS_TTL_MS) return cached.n;

    try {
      const { rows } = await deps.pool.query<{ n: string }>(
        `SELECT COUNT(DISTINCT matrix_id)::text AS n
           FROM site.chat_messages
          WHERE created_at > now() - interval '${ACTIVE_CHATTERS_WINDOW}'
            AND NOT is_deleted`
      );
      // COUNT comes back as a string from pg for bigint-shaped results, and
      // `Number(undefined)` is NaN rather than a throw — so check explicitly
      // instead of trusting the coercion. (The same silent Number() trap is
      // covered in storePricingServer.test.ts.)
      const n = rows[0] ? Number(rows[0].n) : NaN;
      cached = { n: Number.isFinite(n) ? n : null, at: now };
    } catch {
      // Unknown, not zero. Cached anyway so a database that is down does not
      // get one COUNT(DISTINCT) per vote on top of whatever is already wrong.
      cached = { n: null, at: now };
    }
    return cached.n;
  }

  return { activeChatters };
}

const singleton = createActiveChatters({ pool, nowMs: () => Date.now() });

/** Distinct authors in the last {@link ACTIVE_CHATTERS_WINDOW}, or `null` if unknown. */
export const activeChatters = singleton.activeChatters;
