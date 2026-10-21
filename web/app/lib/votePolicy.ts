// The per-target vote clamp, in ONE place.
//
// Against a bot upvoting/downvoting specific people: a viewer may cast at most
// VOTE_TARGET_MAX *new* votes at any one author inside VOTE_TARGET_WINDOW_MS.
// It is deliberately keyed by (voter → author), not by voter alone — a busy
// honest reader voting across many people is not the thing being stopped.
//
// CHANGING an existing vote is exempt, and so is clearing one; only a vote on
// a message this viewer has not voted on before counts. See the route.
//
// THESE NUMBERS ARE ALSO USER-FACING COPY. Duplicated across the route, its
// test and the client, they drift — the same shape as a composer that
// hardcodes "every 5 minutes" and goes on saying it after the cooldown
// changes. Derive the sentence, never retype the number.

export const VOTE_TARGET_WINDOW_MS = 30_000;
export const VOTE_TARGET_MAX = 2;

/** Broader per-viewer ceiling — abuse backstop, not the thing users bump into. */
export const VOTE_GLOBAL_WINDOW_MS = 60_000;
export const VOTE_GLOBAL_MAX = 40;

const seconds = Math.round(VOTE_TARGET_WINDOW_MS / 1000);

/**
 * What a refused vote says. Shown as the vote control's tooltip while the row
 * is in its transient `_voteCooling` state.
 */
export const VOTE_COOLING_TITLE =
  `Too fast — ${VOTE_TARGET_MAX} votes per person every ${seconds}s. That one didn't count.`;

// ── Crowd auto-pin: how many net upvotes pin a message ──────────────────────
//
// A fixed 3 points is likely too low a bar on a busy stream; scale it with
// active chatters.
//
// Pinning costs no points: there is no `pin` row in site.store_prices and no
// spend route. The "3" is this NET-UPVOTE threshold. Casting a vote *earns* 1
// point (earnRules), which is easily mistaken for a price.
//
// SCALE SUB-LINEARLY. Measured over 30 days of real votes, joining each voted
// message to the distinct-author count of its own 15-minute window:
//
//   chatters   avg score   p95   reached>=3   >=4   >=5
//   <=5          1.12       2         3         0     0
//   6-10         1.29       3        49        10     1
//   11-15        1.43       3       135        42    17
//   16+          1.51       4       136        60    22
//
// Score DOES rise with the crowd, but weakly: the average moves 1.12 -> 1.51
// while the crowd roughly quadruples. A linear `chatters * f` would demand
// 7-12 upvotes on a busy stream, and only 22 messages in the whole window ever
// reached 5 there. Auto-pin would stop firing exactly when a pin is most
// useful. The p95 column is the honest anchor: it steps 2 -> 3 -> 3 -> 4, so
// the threshold should step by ONE across the entire observed range, not
// multiply.
//
// Chosen: +1 per 12 concurrent chatters. At the measured median (10) that is 3,
// deliberately, and it only tightens on a busy stream, where the data says
// scores really are higher. Clamped so it can never run away if the site grows
// past anything measured here.
export const AUTO_PIN_BASE = 3;
/** @test-only the curve's slope; callers ask `autoPinScore`, they never step it
 *  themselves. Exported so autoPin.test.ts asserts the step at its exact
 *  boundary rather than restating 12 and drifting from it. */
export const AUTO_PIN_CHATTERS_PER_STEP = 12;
/** @test-only the ceiling, for the same reason. Its whole job is to fail
 *  SILENTLY-proof: too high a bar does not error, it just means nothing is ever
 *  pinned again, so the test asserts the clamp rather than trusting it. */
export const AUTO_PIN_MAX = 6;

/**
 * Net upvotes required to auto-pin, given how many people are chatting right now.
 *
 * @param activeChatters distinct authors in the recent window; `null` when that
 *   is unknown (no stream, query failed). Unknown falls back to the BASE — the
 *   permissive end — because refusing to pin is invisible to everyone, whereas
 *   pinning slightly too eagerly is at worst a 10-minute annoyance that the next
 *   auto-pin replaces.
 */
export function autoPinScore(activeChatters: number | null): number {
  if (activeChatters == null || activeChatters < 0) return AUTO_PIN_BASE;
  const stepped = AUTO_PIN_BASE + Math.floor(activeChatters / AUTO_PIN_CHATTERS_PER_STEP);
  return Math.min(stepped, AUTO_PIN_MAX);
}
