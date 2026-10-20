// Keyset pagination cursor for combined-chat history (/api/chat/history).
//
// The server orders the merged feed by the tuple (created_at, platform, id);
// the client walks it backwards by echoing the oldest row it holds as
// (beforeTs, beforePlatform, beforeId). `beforeMs` is the millisecond
// fallback bound used before a full-precision cursor exists (first page of a
// run) — `cts` (created_at as full-precision text) is what makes later pages
// exact, because Date.getTime() would truncate the microseconds.
//
// Dependency-free on purpose (the `@/`-alias/extensionless-import-breaks-
// node--test gotcha, same as canonicalFromMatrix) so the test imports it
// directly; useChatMessages re-exports nothing — it just consumes these.

// Minimal structural row shape — ChatMsg (and the hook's HistMsg) satisfy it.
export type HistRow = {
  platform: string;
  id: number | string;
  ts: number | string;
  /** Full-precision created_at text — present only on history-fetched rows. */
  cts?: string;
};

export type HistCursor = { beforeMs: number; tsIso?: string; platform?: string; id?: number };

// Live broadcasts carry epoch-ms numbers; be tolerant of string timestamps.
export function msgTs(m: Pick<HistRow, "ts">): number {
  if (typeof m.ts === "number") return m.ts;
  const n = Number(m.ts);
  return Number.isFinite(n) ? n : Date.parse(String(m.ts));
}

// Build the history query string for a cursor. The first page (no tsIso) sends
// just `before` (ms); later pages add the full-precision keyset triple.
export function cursorQuery(c: HistCursor): string {
  let q = `before=${c.beforeMs}`;
  if (c.tsIso && c.platform && c.id != null) {
    q += `&beforeTs=${encodeURIComponent(c.tsIso)}` +
         `&beforePlatform=${encodeURIComponent(c.platform)}` +
         `&beforeId=${c.id}`;
  }
  return q;
}

// The keyset cursor for a freshly-fetched history row (server returns oldest-first,
// so a page's [0] is its oldest row → the next page's cursor).
export function cursorOf(m: HistRow): HistCursor {
  return { beforeMs: msgTs(m), tsIso: m.cts, platform: m.platform, id: Number(m.id) };
}

// Cursor for the START of a scroll-back run, seeded from the oldest row the
// buffer actually shows.
//
// Run lifecycle (useChatMessages' runActiveRef): a run begins on the first
// loadOlder after mount or a re-anchor (runActiveRef false → seed via this
// function, mark the run active) and ends when the user re-anchors to bottom
// (handleAnchored clears the flag). Within a run the cursor must advance
// monotonically even when a page returns only already-seen rows — but BETWEEN
// runs the buffer's front is trimmed (the anchored MAX_MESSAGES cap on every
// live message, and the re-anchor shed), so a cursor left where the last run
// ended skips everything trimmed since: scrolling up then jumped to messages
// far older than the oldest visible row, with the in-between chat missing (the
// "history gap"). Re-seeding from the on-screen oldest closes it.
//
// History-fetched rows carry `cts` → full-precision keyset, exact boundary.
// Live WS rows don't → fall back to the ms bound, +1ms so same-ms siblings
// can't be skipped (the caller's dedupe drops the boundary row itself).
export function seedRunCursor(oldest: HistRow | undefined): HistCursor | null {
  if (!oldest) return null;
  return oldest.cts ? cursorOf(oldest) : { beforeMs: msgTs(oldest) + 1 };
}
