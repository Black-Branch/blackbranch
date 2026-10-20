// The live census singleton: one map for this process, and the flush that
// writes it down. Separate from the route because a Next route file may export
// only handlers and config, and the mod readout route needs currentCensus().
//
// MEASUREMENT MUST NEVER TAKE THE STATUS ROUTE DOWN. /api/stream/status is
// how the whole site learns whether the streamer is live — the tab title, the rail, the
// tab auto-switch and the source fallback all key on its answer. This module
// throws freely; its CALLER is what swallows — and, just as importantly, does
// not await this call at all (see the route), because a hang is not a throw:
// a `try/catch` around an `await` of this function cannot save the response
// from a query that never settles.
//
// See app/lib/sourceCensus.ts for what is counted, the privacy shape, and the
// single-process assumption this map rests on.
import pool from "@/lib/db";
import {
  countSources, createFlushGate, hasFreshEntry, parseCensusSource, parseTabId, recordSample, type CensusMap,
} from "@/app/lib/sourceCensus";

const census: CensusMap = new Map();
const flushGate = createFlushGate();

/** Record one poll and, at most once a minute, write the rolling count down. */
export async function recordAndMaybeFlush(params: URLSearchParams, now: number = Date.now()): Promise<void> {
  const source = parseCensusSource(params.get("src"));
  const tab = parseTabId(params.get("tab"));
  // An older client, a poll from anything that is not our player, or our own
  // first poll of a page load (which has nothing honest to report yet — see
  // useStreamStatusPoll's empty-ref case) all fail this check the same way:
  // simply not voting. It must still get its status.
  if (source && tab) recordSample(census, tab, source, now);
  // Nobody watching means no row, which is the correct amount of data about
  // nobody (see this module's header, sourceCensus.ts's header, and
  // migrate-v117.sql). Checked BEFORE the flush gate, and the gate is left
  // untouched on this path — entering `beginIfDue` here and then abandoning
  // the flush would still consume its stamp, delaying the first REAL row by
  // up to a full FLUSH_EVERY_MS once someone actually arrives.
  //
  // hasFreshEntry, not countSources: it returns on the first fresh entry it
  // finds, so this check costs O(1) whenever anyone is actually watching —
  // the common case, and the one every open tab's 30s poll hits. countSources'
  // full walk is deferred below, inside the flush gate, where it runs at
  // most once a minute again instead of on every request (see
  // sourceCensus.ts's MAP_CAP docblock).
  if (!hasFreshEntry(census, now)) return;
  // The gate (createFlushGate, app/lib/sourceCensus.ts) decides AND stamps in
  // one synchronous step, so two calls before either INSERT starts cannot
  // both begin a flush. `finish()` runs in a finally, so an INSERT that
  // REJECTS still clears the gate for the next call. See that module's
  // header for the deliberate exception: an INSERT that never SETTLES leaves
  // the gate in-flight and stops this process's flushing for good, rather
  // than risk a second write against a database that is already not
  // answering.
  if (!flushGate.beginIfDue(now)) return;
  try {
    const c = countSources(census, now);
    await pool.query(
      `INSERT INTO site.player_source_snapshots
         (native, streamplace, youtube, twitch, community, radio, folded)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      // c.none becomes the `folded` column, but the bucket also holds an
      // active VOD replay: sourceFromState (app/lib/playerSource.ts) returns
      // null on the Replay tab and StreamView maps that null to "none" the
      // same as an actually-folded player (see migrate-v117.sql). Despite the
      // column name, this is "folded OR watching a VOD", not only "folded".
      [c.native, c.streamplace, c.youtube, c.twitch, c.community, c.radio, c.none],
    );
  } finally {
    flushGate.finish();
  }
}

/** The live count, for the mod readout (app/api/mod/player-sources). */
export function currentCensus() {
  return countSources(census, Date.now());
}
