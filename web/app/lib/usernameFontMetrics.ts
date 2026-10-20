// Measured font metrics behind the `scale` column of FONT_STACKS (usernameStyles.ts).
//
// @test-only the test IS the consumer by design — these numbers exist to let
// usernameStyles.test.ts re-derive the shipped scales. Production reads the
// derived `scale`, never the metrics, because a per-render font measurement is
// exactly the per-frame cost the chat row cannot afford.
//
// THIS FILE EXISTS SO A SCALE CANNOT BE HAND-EDITED. Scales tuned by eye leave
// faces nobody re-measured. usernameStyles.test.ts recomputes every scale from
// these numbers using the documented rule and fails if the shipped table
// disagrees — so changing a scale means changing a MEASUREMENT, which means
// re-running the script and saying what you observed.
//
// Provenance: measured in Chrome with the real loaded webfonts, via canvas
// TextMetrics + getImageData at 400px (reproducible run to run). Reference is
// Geist at weight 600 — the weight and family a plain chat username renders in
// (--chat-username-font defaults to inherit). Reproduce with
// `web/scripts/measure-username-scales.js`.
//
// `word` is the width of "Handgloves" over the em, and it is not decorative:
// it is the LOAD PROOF. Handing the full font stack to document.fonts.load()
// instead of the first family measures the metric-override fallback for most
// faces — every one reporting capH 0.655 / x 0.46. Identical metrics across
// unrelated faces is the tell, and the test asserts all 19 `word` values are
// distinct so such a run cannot ship.

export type FaceMetrics = {
  /** Ink ascent of 'H', in em. */
  capH: number;
  /** Ink ascent of 'x', in em. */
  x: number;
  /** Advance width of "Handgloves", in em. Load proof only — never an input. */
  word: number;
  /** Ink coverage of the x-band strip "oneruxvzmscw" over its own ink box. */
  xCov: number;
  /** Ink coverage of 'H' over its own ink box — how SOLID the caps are. */
  capCov: number;
  /** Median ink-run count across mid-band rows of the 'i' stem. Solid stem = 1. */
  iRuns: number;
  /** Median ink-run count across rows of '.'. Solid blob = 1; outline ring = 2. */
  dotRuns: number;
  /** Advance of one space, in em (the space term, see wordSpacingFor). */
  space: number;
};

/** Geist @600 — what a name with no equipped font renders in. */
export const REFERENCE_METRICS: FaceMetrics =
  { capH: 0.7188, x: 0.5469, word: 5.6608, xCov: 0.4671, capCov: 0.5393, iRuns: 1, dotRuns: 1, space: 0.244 };

export const FONT_METRICS: Record<string, FaceMetrics> = {
  gothic:      { capH: 0.7813, x: 0.5781, word: 4.042, xCov: 0.4907, capCov: 0.492, iRuns: 1, dotRuns: 1, space: 0.19 },
  arcade:      { capH: 1, x: 0.75, word: 10, xCov: 0.5284, capCov: 0.6327, iRuns: 1, dotRuns: 1, space: 1 },
  script:      { capH: 0.8906, x: 0.4844, word: 4.846, xCov: 0.5418, capCov: 0.382, iRuns: 1, dotRuns: 1, space: 0.253 },
  comic:       { capH: 0.75, x: 0.7344, word: 4.212, xCov: 0.6094, capCov: 0.5127, iRuns: 1, dotRuns: 1, space: 0.195 },
  horror:      { capH: 0.75, x: 0.75, word: 4.293, xCov: 0.5725, capCov: 0.7269, iRuns: 1, dotRuns: 1, space: 0.2354 },
  western:     { capH: 0.7656, x: 0.5781, word: 6.1465, xCov: 0.4208, capCov: 0.4784, iRuns: 2, dotRuns: 2, space: 0.2441 },
  street:      { capH: 0.7344, x: 0.7344, word: 7.162, xCov: 0.6234, capCov: 0.7621, iRuns: 1, dotRuns: 1, space: 0.225 },
  cyber:       { capH: 0.7031, x: 0.5313, word: 6.5103, xCov: 0.4767, capCov: 0.4622, iRuns: 1, dotRuns: 1, space: 0.3252 },
  typewriter:  { capH: 0.7031, x: 0.4844, word: 5.8291, xCov: 0.3658, capCov: 0.3658, iRuns: 1, dotRuns: 2, space: 0.293 },
  imperial:    { capH: 0.7031, x: 0.6094, word: 6.698, xCov: 0.2037, capCov: 0.2299, iRuns: 1, dotRuns: 1, space: 0.25 },
  hand:        { capH: 0.7031, x: 0.3594, word: 3.717, xCov: 0.267, capCov: 0.2106, iRuns: 1, dotRuns: 1, space: 0.242 },
  neon:        { capH: 0.8125, x: 0.7031, word: 7.748, xCov: 0.3418, capCov: 0.3867, iRuns: 4, dotRuns: 0, space: 0.1084 },
  terminal:    { capH: 0.5625, x: 0.4063, word: 4, xCov: 0.4507, capCov: 0.5569, iRuns: 1, dotRuns: 1, space: 0.4 },
  marker:      { capH: 0.75, x: 0.5938, word: 5.5928, xCov: 0.4917, capCov: 0.5068, iRuns: 1, dotRuns: 1, space: 0.3896 },
  elegant:     { capH: 0.75, x: 0.4219, word: 4.044, xCov: 0.2077, capCov: 0.1411, iRuns: 2, dotRuns: 1, space: 0.198 },
  bubble:      { capH: 0.7344, x: 0.5625, word: 4.4346, xCov: 0.5465, capCov: 0.699, iRuns: 1, dotRuns: 1, space: 0.2354 },
  stencil:     { capH: 0.6563, x: 0.5313, word: 6.2183, xCov: 0.6051, capCov: 0.7132, iRuns: 1, dotRuns: 1, space: 0.2588 },
  retro:       { capH: 0.75, x: 0.5938, word: 7.2905, xCov: 0.6999, capCov: 0.8291, iRuns: 1, dotRuns: 1, space: 0.3496 },
  relief:      { capH: 0.7969, x: 0.5781, word: 6.033, xCov: 0.3006, capCov: 0.3654, iRuns: 2, dotRuns: 2, space: 0.32 },
  scrawl:      { capH: 0.7344, x: 0.5313, word: 5.21, xCov: 0.2901, capCov: 0.3664, iRuns: 1, dotRuns: 1, space: 0.4502 },
  crafty:      { capH: 0.7656, x: 0.5156, word: 5.7861, xCov: 0.2276, capCov: 0.1825, iRuns: 1, dotRuns: 1, space: 0.3799 },
  friendly:    { capH: 0.7188, x: 0.5156, word: 5.918, xCov: 0.4832, capCov: 0.4736, iRuns: 1, dotRuns: 1, space: 0.343 },
  brush:       { capH: 0.75, x: 0.4844, word: 4.411, xCov: 0.3426, capCov: 0.3214, iRuns: 1, dotRuns: 1, space: 0.246 },
  cursive:     { capH: 0.7969, x: 0.4531, word: 5.057, xCov: 0.217, capCov: 0.2537, iRuns: 2, dotRuns: 1, space: 0.354 },
  rounded:     { capH: 0.7813, x: 0.5625, word: 6.196, xCov: 0.3277, capCov: 0.347, iRuns: 1, dotRuns: 1, space: 0.293 },
  quirky:      { capH: 0.7188, x: 0.5938, word: 5.003, xCov: 0.3918, capCov: 0.3641, iRuns: 1, dotRuns: 1, space: 0.26 },
  spray:       { capH: 0.6563, x: 0.5938, word: 5.345, xCov: 0.3107, capCov: 0.3663, iRuns: 1, dotRuns: 1, space: 0.38 },
  fantasy:     { capH: 0.75, x: 0.5938, word: 6.3228, xCov: 0.2975, capCov: 0.3646, iRuns: 1, dotRuns: 1, space: 0.3325 },
  calligraphy: { capH: 0.7344, x: 0.5156, word: 4.5229, xCov: 0.2683, capCov: 0.2701, iRuns: 1, dotRuns: 1, space: 0.25 },
  notched:     { capH: 0.7656, x: 0.5625, word: 5.2036, xCov: 0.3266, capCov: 0.3481, iRuns: 1, dotRuns: 1, space: 0.3906 },
  jersey:      { capH: 0.625, x: 0.4688, word: 4.3902, xCov: 0.5492, capCov: 0.6422, iRuns: 1, dotRuns: 1, space: 0.2439 },
};

/**
 * A face is HOLLOW when its strokes are outlines rather than solid ink: the 'i'
 * stem and the period both scan as multiple ink runs (or the stem alone scans
 * 3+, which nothing but a multi-line face like Monoton produces). Two glyphs
 * ANDed because each alone false-positives: cursive swash tails put a second
 * run on 'i' rows (Great Vibes), and distress speckle splits the period
 * (Special Elite). Neither face is hollow; Rampart and Monoton are.
 */
export function isHollow(m: FaceMetrics): boolean {
  return (m.iRuns >= 2 && m.dotRuns >= 2) || m.iRuns >= 3;
}

/**
 * The exponent the optical terms below share. Calibrated by rendering
 * candidates beside a plain name at chat size against the two faces that read
 * wrong (relief a little small, script a tad big); the same ¼ lands the
 * narrow-face lift on an eye-match.
 */
const OPTICAL_EXPONENT = 0.25;

/** No face's lowercase may render below this fraction of a plain name's. */
const MIN_X_PARITY = 0.92;

/**
 * The scale a face should carry, derived from its metrics.
 *
 * Every face should feel comparable to the size of a plain username, judged
 * from a sheet of every face beside a plain name at real chat size. An
 * x-height-anchored rule keeps the lowercase level and lets everything else
 * drift: Comic, Horror and Blackletter read small (all capitals, or
 * condensed), while Handwritten and Elegant's capitals tower over the names
 * around them. Four steps, in order:
 *
 * 1. **Extent — the whole letter, not just the lowercase.** Mean glyph height
 *    `(capH + x)` against the reference's. A face that draws every glyph at one
 *    height (x/capH > 0.9: Bangers, Creepster, Bungee) has no lowercase to
 *    average in; every name in it IS capitals, so its capitals are matched to a
 *    plain name's capitals instead (`ref.capH / capH`).
 * 2. **Hollow make-up (relief, neon, western).** An outline face lays down a
 *    fraction of the ink, and faint reads small; see isHollow.
 *    (ref.xCov / xCov)^¼. Without it Neon and 3D read small. Not a global
 *    darkness term — measured and refuted: solid faces' lightness is
 *    typographic voice, not size.
 * 3. **Narrow lift.** A condensed face covers less of the line and reads small
 *    at equal height (Blackletter, Comic). Lifted by (ref.word / rendered
 *    word)^¼ — and ONLY lifted: a wide face (Arcade, Street) already reads big.
 * 4. **Readable-lowercase floor.** Whatever the steps above did, a face's
 *    lowercase never renders below 0.92 of a plain name's — the deep-lowercase
 *    scripts (Handwritten, Elegant, Brush) would otherwise be sized by their
 *    towering capitals into an unreadable lowercase.
 *
 * `word` is the load proof and also step 3's input.
 */
export function scaleFor(m: FaceMetrics, ref: FaceMetrics = REFERENCE_METRICS): number {
  const capsOnly = m.x / m.capH > 0.9;
  let s = capsOnly ? ref.capH / m.capH : (ref.capH + ref.x) / (m.capH + m.x);
  if (isHollow(m)) s *= Math.pow(ref.xCov / m.xCov, OPTICAL_EXPONENT);
  s *= Math.pow(Math.max(1, ref.word / (m.word * s)), OPTICAL_EXPONENT);
  s = Math.max(s, (MIN_X_PARITY * ref.x) / m.x);
  // Two decimals: the table is read and diffed by humans, and the third decimal
  // is below the rounding of a chat-size render anyway.
  return Math.round(s * 100) / 100;
}

/**
 * The `word-spacing` (in em of the SCALED name) that makes a space in this face
 * exactly as wide as a plain name's space.
 *
 * A name can have a space in it: Terminal is monospace, so its space is a full
 * letter cell — 11.5px at chat size against a plain name's 5.3px, and Arcade's
 * is 16px. `word-spacing` is ADDED to the face's own space, and it is in em of
 * the element, which is already scaled — hence the division.
 * Two decimals, like the scale.
 */
export function wordSpacingFor(m: FaceMetrics, ref: FaceMetrics = REFERENCE_METRICS): number {
  const s = scaleFor(m, ref);
  return Math.round(((ref.space - m.space * s) / s) * 100) / 100;
}
