// Nudge timing policy (migrate-v90) — pure, so the 48 h / never-again rules
// are unit-testable without a database. The route feeds it the row and the
// linked-account answer; nothing else may reimplement this arithmetic.

// @test-only nudges.test.ts asserts the 48h clock without restating it.
export const NUDGE_RETURN_MS = 48 * 60 * 60 * 1000;

export type NudgeRow = { dismissed_at: Date; count: number; never: boolean };

/**
 * Should the link-account nudge show, and may the UI offer "never again"?
 *
 * The rules: shows while the user has no linked platform account;
 * a dismissal hides it for 48 h; from the SECOND showing on (i.e. it has been
 * dismissed at least once) the card also offers never-again; never latches.
 */
export function linkNudgeState(
  linked: boolean,
  row: NudgeRow | undefined,
  now: number,
): { show: boolean; offerNever: boolean } {
  const snoozed = row ? row.never || now - row.dismissed_at.getTime() < NUDGE_RETURN_MS : false;
  return {
    show: !linked && !snoozed,
    offerNever: (row?.count ?? 0) >= 1,
  };
}
