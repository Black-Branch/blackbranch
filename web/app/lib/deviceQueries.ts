/**
 * THE FOUR DEVICE QUESTIONS. Each answers something different; none is "the"
 * mobile check. Pick by the question you are actually asking:
 *
 *   Q_NARROW         — "is there room for two columns?"  LAYOUT branching.
 *   Q_DEVICE_MOBILE  — "is the paint budget small, and where do this viewer's
 *                      settings belong?"  PAINT DEFAULTS + settings scope.
 *                      Persisted as `device_class`; see deviceClass.ts.
 *   Q_POINTER_COARSE — "does touch input exist?"  TOUCH AFFORDANCES
 *                      (long-press, focus keeping, emote triggers).
 *   Q_TOUCH_PRIMARY  — "is touch the primary input?"  KEYBOARD/VIEWPORT
 *                      behaviour, where a touchscreen laptop must NOT count.
 *
 * Q_NARROW and Q_DEVICE_MOBILE deliberately DISAGREE between 768px and
 * 1024px on a coarse pointer (tablets, big phones in landscape). Do not
 * "reconcile" them — same family as clampGeom vs reachableBox, where merging
 * two correct-but-different rules is the tempting simplification and the wrong
 * one. deviceQueries.test.ts fails if they ever converge.
 *
 * What a tablet SHOULD be is an open product question. It is named here so
 * it can be decided on purpose, not settled by whichever query a call site
 * happened to reach for.
 *
 * THIS FILE IMPORTS NOTHING, AND MUST NOT. `deviceClass()` is reached from
 * a server route (settingsRegistry -> settingsKeys -> api/me/settings), so a
 * React import here poisons the Server Component graph — the build fails with
 * "useSyncExternalStore ... only available in Client Components". That is why
 * the hook lives in useNarrowViewport.ts instead of beside these constants.
 */

// @test-only deviceQueries.test.ts proves Q_NARROW derives from it and cannot drift.
export const NARROW_BREAKPOINT = 768; // matches globals.css @media and Tailwind `md:`

export const Q_NARROW = `(max-width: ${NARROW_BREAKPOINT - 1}px)`;
export const Q_DEVICE_MOBILE = "(pointer: coarse) and (max-width: 1024px)";
export const Q_POINTER_COARSE = "(pointer: coarse)";
export const Q_TOUCH_PRIMARY = "(pointer: coarse) and (hover: none)";
