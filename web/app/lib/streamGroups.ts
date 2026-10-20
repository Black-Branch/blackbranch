// Sessions → logical streams (the Stream tab). Pure, so node --test pins it.
//
// stream-ingest opens a NEW stream_id on every reconnect, so one real stream can span several
// stream.sessions rows; and a past backfill bulk-closed dangling rows with one shared ended_at,
// leaving multi-day "durations". Both are display defects — the tab only reads stream.*, so the
// repair lives here, not in the database. All times are epoch milliseconds.

// The poller snapshots a live stream at least this often (stream-api lifecycle.js HEARTBEAT_MIN), so
// the last snapshot plus one heartbeat bounds the true end.
const HEARTBEAT_MS = 10 * 60_000;

/** Measured (94 sessions): reconnect gaps are 0–26 min, real between-stream gaps 5 h+.
 *  @test-only the boundary test pins the exact threshold */
export const MERGE_GAP_MS = 60 * 60_000;

/** Closed streams shorter than this are test blips and crashed starts, not streams.
 *  @test-only the visibility test pins the exact floor */
export const MIN_GROUP_MS = 10 * 60_000;

export type SessionRow = { streamId: string; startedMs: number; endedMs: number | null; lastSnapMs: number | null };

export type SessionGroup = {
  /** Chronological; [0] is the group's id (the picker's key). */
  streamIds: string[];
  startedMs: number;
  /** null while the newest segment is still open (live now). */
  endedMs: number | null;
  /** First start → last effective end; null while open. */
  durationMs: number | null;
  segments: number;
};

/**
 * The end a session actually reached: ended_at, never later than the last viewer snapshot plus one
 * heartbeat. No snapshots at all → it never really ran → zero length. Open stays open (null).
 * @test-only the repair rule is unit-tested directly; the tab reaches it through groupSessions
 */
export function effectiveEndMs(row: SessionRow): number | null {
  if (row.endedMs === null) return null;
  if (row.lastSnapMs === null) return row.startedMs;
  return Math.min(row.endedMs, row.lastSnapMs + HEARTBEAT_MS);
}

/** Merge sessions into logical streams; newest first. */
export function groupSessions(rows: readonly SessionRow[]): SessionGroup[] {
  const sorted = [...rows].sort((a, b) => a.startedMs - b.startedMs);
  const groups: SessionGroup[] = [];
  // The group end the merge compares against; an overlap makes the gap negative, which merges.
  let cmpEnd = 0;
  for (const r of sorted) {
    const end = effectiveEndMs(r);
    const last = groups[groups.length - 1];
    if (last && r.startedMs - cmpEnd <= MERGE_GAP_MS) {
      last.streamIds.push(r.streamId);
      last.segments += 1;
      if (end === null) last.endedMs = null;
      else if (last.endedMs !== null) last.endedMs = Math.max(last.endedMs, end);
      last.durationMs = last.endedMs === null ? null : last.endedMs - last.startedMs;
    } else {
      groups.push({ streamIds: [r.streamId], startedMs: r.startedMs, endedMs: end, durationMs: end === null ? null : end - r.startedMs, segments: 1 });
    }
    cmpEnd = Math.max(cmpEnd, end ?? r.startedMs);
  }
  return groups.reverse();
}

/** Drop closed groups under MIN_GROUP_MS; an open group is always visible. */
export function visibleGroups(groups: readonly SessionGroup[]): SessionGroup[] {
  return groups.filter((g) => g.durationMs === null || g.durationMs >= MIN_GROUP_MS);
}
