import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { currentCensus } from "@/app/lib/sourceCensusStore";

// GET — which player our own visitors are actually using: the live count from
// this process, plus the last 24 hours of flushed rows.
//
// NOT comparable with the "N watching" figure elsewhere on the site. That one
// comes from stream.viewer_snapshots — each PLATFORM's own audience, counted by
// stream-ingest. This counts people who came to the site and chose a player.
// Someone watching on the Twitch app is in that number and not in this one.
//
// Both halves of this payload — the live `now` (census vocabulary, whose key
// for this bucket is `none`) and the persisted `history` (the
// `site.player_source_snapshots.folded` column, populated from that same
// `none` at insert time — see sourceCensusStore.ts) — report the SAME
// quantity, so both are reshaped here to the one name a reader of this route
// needs: `foldedOrVod`. The column is named `folded`, but it also counts
// someone actively watching a VOD replay, not only a folded player —
// sourceFromState returns null on the Replay tab and StreamView maps that
// null to the same bucket; this route reports what the bucket actually holds
// rather than either underlying name.
//
// INTERPRETATION HAZARD, same kind as the foldedOrVod one above: this counts
// SELECTIONS, and streamplace is the default player ONLY WHILE THE STREAMER IS LIVE.
// Anyone who never touched the source picker is counted there whether or not
// they would have picked it, so "nobody wants Twitch" and "nobody moved off
// the default" produce identical numbers here. While OFFLINE the untouched
// default is radio instead (StreamView.tsx seeds the tab to Radio whenever
// nobody is live, and availableSources offers only community + radio then),
// so the same hazard sits in the radio column for most of the day. This table
// alone cannot tell either apart.
//
// `now` is built by rest-spreading currentCensus() (whatever keys that
// returns), while `history` names each column explicitly — so a census source
// added to sourceCensus.ts's vocabulary would appear in `now` immediately but
// silently stay absent from `history` until this SELECT and map are updated
// too.
export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  // LIMIT 1500 is a safety cap, not a real bound at "at most one row a
  // minute" (that would be ~1440 rows/day): a process restart flushes
  // immediately regardless of the minute-gate, so a day with several deploys
  // can carry more rows than a quiet day and, past the cap, silently return
  // less than the full 24 hours with nothing in the payload to say so.
  const { rows } = await pool.query(
    `SELECT recorded_at, native, streamplace, youtube, twitch, community, radio, folded
     FROM site.player_source_snapshots
     WHERE recorded_at > NOW() - INTERVAL '24 hours'
     ORDER BY recorded_at DESC
     LIMIT 1500`
  );

  const { none: nowFoldedOrVod, ...nowRest } = currentCensus();

  return Response.json({
    now: { ...nowRest, foldedOrVod: nowFoldedOrVod },
    history: rows.map((r) => ({
      recordedAt: new Date(r.recorded_at).toISOString(),
      native: r.native, streamplace: r.streamplace, youtube: r.youtube,
      twitch: r.twitch, community: r.community, radio: r.radio,
      foldedOrVod: r.folded,
    })),
  });
}
