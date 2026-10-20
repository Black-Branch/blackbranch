// Fund the Night: pure matching logic for the chat clock badge — split out of
// useSponsorState.ts (a "use client" hook file, unimportable under node --test
// without a React dispatcher — same reason timerLowState.ts sits beside
// useStreamTimer.ts, and badgeOrder.ts beside BadgesContext.tsx) so this can be
// tested directly.

/** One row of stream-api's `sponsorState` frame (sponsors.js `buildFrame()`). */
export type Sponsor = {
  name: string;
  /** Other names this person was credited under — the platform donation name
   *  when `name` is their site display name (see wsFrames.ts). Optional: an
   *  older frame shape omits it. */
  aliases?: string[];
  weightPct: number;
  clockRemainSec: number;
  /** Current badge window length; the sweep's denominator (see wsFrames.ts). */
  clockTotalSec: number;
};

/** Does a frame row belong to the sender of a chat line shown as `key`
 *  (lowercased, trimmed)? By the row's name, or by any alias — a Streamlabs
 *  donor credited as their site display name "Gadget Qorm" (the name chat
 *  shows for their native messages) still lights up on a Twitch-side
 *  "GadgetFan" line, because that donation name rides along as an alias. */
function rowMatches(s: Sponsor, key: string): boolean {
  if (typeof s?.name === "string" && s.name.trim().toLowerCase() === key) return true;
  return Array.isArray(s?.aliases) && s.aliases.some((a) => typeof a === "string" && a.trim().toLowerCase() === key);
}

/**
 * How many seconds of tonight's clock a given chat row's sender is currently
 * keeping funded — 0 if they aren't in the pool, or are but not funding the
 * CURRENT moment (`clockRemainSec` is server-clamped to >= 0, never negative).
 *
 * Matches by NAME (or alias), case-insensitive — the frame carries the names
 * chat shows, not canonical ids: sponsors.js names each row by the linked site
 * account's display_name when there is one, else by the donation name, and
 * the pool is keyed on the canonical id both live and after a restart. Several
 * rows can still share a name (an old-shape caller with no id, a hand-merged
 * pair); this matcher sums every row that matches so a viewer's badge reflects
 * the full pool.
 */
export function clockRemainSecFor(
  sponsors: readonly Sponsor[] | null | undefined,
  username: string | null | undefined
): number {
  const key = (username ?? "").trim().toLowerCase();
  if (!key || !sponsors) return 0;
  let total = 0;
  for (const s of sponsors) {
    if (rowMatches(s, key)) {
      const sec = Number(s.clockRemainSec);
      if (Number.isFinite(sec) && sec > 0) total += sec;
    }
  }
  return total;
}

/**
 * The sweep badge's fill for a chat row's sender: remaining ÷ window, in
 * [0, 1], summed across every matching row the same way clockRemainSecFor is
 * (the live-vs-replay duplicate-row limitation applies identically). 0 when
 * the sender isn't funding the current moment. A row whose window is missing
 * or zero but still has time remaining (an older frame shape, or a degenerate
 * mint) reads as FULL rather than empty — a lit badge with an unknown length
 * is still lit.
 */
export function clockFracFor(
  sponsors: readonly Sponsor[] | null | undefined,
  username: string | null | undefined
): number {
  const key = (username ?? "").trim().toLowerCase();
  if (!key || !sponsors) return 0;
  let remain = 0;
  let total = 0;
  for (const s of sponsors) {
    if (!rowMatches(s, key)) continue;
    const r = Math.max(0, s.clockRemainSec || 0);
    remain += r;
    total += Math.max(r, s.clockTotalSec || 0);
  }
  if (remain <= 0) return 0;
  if (total <= 0) return 1;
  return Math.min(1, remain / total);
}
