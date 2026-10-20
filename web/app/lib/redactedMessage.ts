// Supporter "redacted message" — the shared pieces. (Not "encrypted": that word
// is confused with the Matrix rooms' real end-to-end encryption. The DB column
// `encrypted_text`, the wire flag `encrypted` and the `/api/chat/decrypt` path
// keep the older name — renaming a live column and a wire field buys nothing a
// reader can see.)
//
// Pure and dependency-free so BOTH sides can use it: the server parses the
// `||hidden||` marks and scrambles the hidden parts once at send time (the
// scramble is what gets stored, broadcast and mirrored to the bot's corpus),
// and the client finds the hidden runs again in that stored text.
//
// This is a site feature gated on a Supporter subscription, not cryptography:
// the server holds the plaintext and hands it to anyone entitled to read it.

/**
 * The scramble alphabet.
 *
 * THE BROWSER DOES NOT PAINT THESE. RedactedText finds the hidden runs by these
 * glyphs and draws a bar over a plain filler in the chat's own font. The glyphs
 * are still what is stored and broadcast, so they are what the OBS overlay, the
 * bot's corpus and any non-browser reader see — which is why RULE 1 below still
 * holds. The font notes (RULE 2 onward) matter to those readers.
 *
 * RULE 1: NO LETTERS OR DIGITS. A scramble drawn from an alphanumeric set can
 * spell a real word by accident — including a slur — and would then be rendered
 * to every viewer, attributed to the sender, in a feature whose whole promise is
 * that nobody can read the message. Block shapes cannot form a word.
 *
 * RULE 2: EVERY GLYPH MUST BE COVERED BY GEIST MONO. This is a layout
 * requirement.
 *
 * A reveal that swaps these for real characters one at a time needs every glyph
 * in the font actually being used: otherwise the browser silently falls back to
 * another font to draw it — and brings that font's advance width with it. The
 * line then changes width as the animation runs, and on a narrow screen a long
 * message gains or loses a LINE mid-reveal and shoves the chat around.
 *
 * ASCII is no answer: it is only monospace if the mono font is actually loaded
 * (`--font-mono` points at `--font-geist-mono`, which needs Geist_Mono imported),
 * and coverage is the real question either way.
 *
 * THE ANSWER IS THE @font-face unicode-range, NOT A BROWSER MEASUREMENT.
 * next/font subsets Google fonts, so the woff2 actually served contains only
 * part of the typeface. Read what is really in it:
 *
 *     grep -o '@font-face{[^}]*}' .next/static/chunks/*.css \
 *       | grep -i mono | sed 's/.*unicode-range://' | sort -u
 *
 * For Geist Mono that is Latin plus exactly `U+23B8-23BD, U+2500-259F`. So Box
 * Drawing and Block Elements are genuinely in the file, and everything else —
 * APL, Miscellaneous Technical, mathematical operators, and Geometric Shapes
 * from U+25A0 up — is NOT, and falls back to a system font.
 *
 * A WIDTH COMPARISON CANNOT PROVE COVERAGE. Comparing a glyph's width under two
 * stacks ("Geist Mono", Courier New) vs ("Geist Mono", Times New Roman) and
 * calling it covered when the widths agree fails when the glyph is in NEITHER
 * named font: both stacks fall through to the same system last-resort font and
 * agree anyway. On a Linux desktop that last resort is DejaVu Sans Mono, whose
 * advance happens to match, so a set can look perfect on desktop and break on
 * Android. The unicode-range can.
 *
 * CHANGING THIS SET DOES NOT ORPHAN OLD MESSAGES. The stored scramble is
 * frozen at send time, so a message sealed under a previous alphabet would
 * otherwise render in the old glyphs and then churn into the new ones. The
 * display therefore REGENERATES the cipher from the stored one's shape, so the
 * stored characters no longer matter; only its length and whitespace do.
 */
/**
 * BLOCK ELEMENTS ONLY — U+2580–U+259F.
 *
 * The safe zone is wider than this: the served font covers U+2500–U+259F, which
 * also takes in all 128 Box Drawing characters. Using the whole thing is
 * rejected on looks — box drawing is mostly thin single lines, so a scramble
 * drawn from it reads as a TABLE or a schematic rather than as redacted text,
 * and at 128-of-152 glyphs it swamps the blocks entirely. Solid fills, shades
 * and quadrants are what make it look like something withheld.
 *
 * So this range is an AESTHETIC narrowing inside a SAFETY range, and the two
 * are not the same rule. Widening back toward U+2500 stays width-safe; going
 * outside U+2500–U+259F does not (see above). The test asserts the safety range,
 * which is the one that breaks people's screens.
 */
const GLYPH_LO = 0x2580;
const GLYPH_HI = 0x259f;

/**
 * Dropped from that range: the four one-eighth blocks. They are covered by the
 * font and correctly sized — they are excluded because they are nearly BLANK,
 * and a scramble sprinkled with near-blanks grows fake word gaps, which undoes
 * the whole point of preserving the message's shape.
 */
const TOO_FAINT = new Set(["▁", "▔", "▏", "▕"]);

/**
 * ALSO DROPPED: the three DITHERED SHADES — their shape and size make the
 * characters overlap.
 *
 * Measured against the real chat cell (21.632px text, 30.28px line box = the
 * default line-height of 1.4), Geist Mono draws these with more INK than the
 * box they sit in:
 *
 *     ▓ U+2593   1.4531em tall · 0.6563em wide   EXCEEDS a 1.4em line box,
 *                                                 and is 5.6% wider than the cell
 *     ▒ U+2592   1.4063em tall                    EXCEEDS a 1.4em line box
 *     ░ U+2591   1.3750em tall                    clears it by half a pixel
 *
 * So they bleed into the lines above and below, and ▓ into the glyph beside it.
 * Everything that remains tops out at 1.3125em, which fits.
 *
 * THE CAUSE IS THE FONT, NOT THE CODEPOINT. Block Elements are drawn to tile
 * a TERMINAL cell seamlessly, which means deliberately overflowing the em square
 * — that is what makes a wall of them look solid with no seams. It is also why
 * this cannot be fixed by picking different blocks: at a line-height below ~1.32
 * even plain █ overlaps, and the chat line-height slider goes down to 1.0. That
 * is an accepted known limit rather than letting the cipher diverge from the
 * user's chosen line height. If the served font is ever changed, RE-MEASURE —
 * do not assume this list still describes it.
 */
const TOO_TALL = new Set(["░", "▒", "▓"]);

// @test-only the alphabet itself has no consumer outside this file — scramble
// is what callers use. redactedMessage.test.ts reads it directly
// because the properties that matter are properties OF THE SET: no letters or
// digits, no duplicates (they skew the draw), at least 24 glyphs, and none of
// the near-blank or over-tall codepoints excluded above. Those cannot be
// asserted through a function that returns one random character at a time.
export const REDACT_GLYPHS = Array.from(
  { length: GLYPH_HI - GLYPH_LO + 1 },
  (_, i) => String.fromCodePoint(GLYPH_LO + i),
)
  .filter((c) => !TOO_FAINT.has(c) && !TOO_TALL.has(c))
  .join("");

/**
 * THE GLYPH CARRIES THE LETTER'S SHAPE. An unchanging width is worth giving
 * away the shape of a word.
 *
 * Each hidden character is stored as the glyph for its rough WIDTH class, and
 * the browser draws the bar over a filler letter of that class (redactFiller),
 * so a sealed word is already close to the width of the real one; RedactedText
 * then spaces the opened word to fill its bar exactly. Anyone can see the
 * outline of the hidden words (thin letters, capitals, digits), never the
 * letters — and the same word always seals the same way. That determinism is
 * the accepted cost.
 *
 * Older stored messages carry RANDOM glyphs. redactFiller reads any glyph it
 * does not know as the average filler "s", so they still render.
 */
type Shape = "thin" | "narrow" | "regular" | "wide" | "capital" | "wideCapital" | "digit" | "zero";

/** Shape → stored glyph. All inside REDACT_GLYPHS (the test asserts it). */
const SHAPE_GLYPH: Record<Shape, string> = {
  thin: "\u258E",        // ▎
  narrow: "\u258C",      // ▌
  regular: "\u2588",     // █
  wide: "\u2599",        // ▙
  capital: "\u2580",     // ▀
  wideCapital: "\u259B", // ▛
  digit: "\u2584",       // ▄
  zero: "\u2597",        // ▗
};

/**
 * Shape → the letter drawn (transparent) under a closed bar. Chosen so the bar
 * lands near the real width in the chat's proportional font; the fit on
 * opening absorbs the rest. `zero` (joiners, variation selectors, combining
 * marks) draws nothing.
 */
const SHAPE_FILLER: Record<Shape, string> = {
  thin: "l", narrow: "t", regular: "e", wide: "m",
  capital: "N", wideCapital: "M", digit: "0", zero: "",
};

/** Average stand-in for a glyph with no shape (a pre-shape, random-glyph row):
 *  measured in Geist at 0.993× real text over ten chat lines. */
const UNKNOWN_FILLER = "s";

function shapeOf(ch: string): Shape {
  if (/[\u200d\ufe0e\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}]|\p{M}/u.test(ch)) return "zero";
  if (/\p{Extended_Pictographic}/u.test(ch)) return "wideCapital";
  if ("ijl.,:;'!|`".includes(ch)) return "thin";
  if ("ftrI()[]{}1-\"/\\".includes(ch)) return "narrow";
  if ("mw".includes(ch)) return "wide";
  if ("MW%@&".includes(ch)) return "wideCapital";
  if (/\p{Nd}/u.test(ch)) return "digit";
  if (/\p{Lu}/u.test(ch)) return "capital";
  return "regular";
}

const FILLER_OF_GLYPH = new Map(
  (Object.keys(SHAPE_GLYPH) as Shape[]).map((k) => [SHAPE_GLYPH[k], SHAPE_FILLER[k]]),
);

/**
 * What to draw under a closed bar for one stored character: whitespace stays
 * itself, a shape glyph becomes its filler letter, any other glyph (an old
 * random-glyph row) the average filler.
 */
export function redactFiller(ch: string): string {
  if (/\s/.test(ch)) return ch;
  return FILLER_OF_GLYPH.get(ch) ?? UNKNOWN_FILLER;
}

/**
 * The placeholder a non-entitled viewer sees.
 *
 * Whitespace is PRESERVED and everything else is replaced 1:1 by its shape
 * glyph, so the line keeps its shape. That leaks the message's length, word
 * count and word OUTLINES — accepted for a chat toy, and worth knowing before
 * anyone treats this as a privacy guarantee.
 */
function scramble(text: string): string {
  return [...text].map((ch) => (/\s/.test(ch) ? ch : SHAPE_GLYPH[shapeOf(ch)])).join("");
}

/**
 * What a hidden part reads as wherever bars cannot be drawn — a message
 * cross-posted to Twitch, YouTube or Kick.
 */
const REDACTED_LABEL = "[REDACTED]";

export type Redaction = {
  /** The message with the marks removed — what the author typed and meant.
   *  Stored ONLY in site.chat_messages.encrypted_text; served only by
   *  /api/chat/decrypt. The word filter and the length limit judge THIS. */
  plain: string;
  /** Hidden parts as shape glyphs 1:1 per code point, visible parts verbatim. What
   *  the site stores as the message and broadcasts to everyone. */
  publicText: string;
  /** Hidden parts replaced by REDACTED_LABEL. What a platform receives. */
  platformText: string;
  /** Does anything need hiding? False = an ordinary message. */
  redacted: boolean;
};

/**
 * Split a typed message into what everyone may see and what only Supporters may.
 * Hidden parts are marked `||like this||` (Discord's spoiler mark).
 *
 * `whole` hides everything (the 🔒 send-to entry and `/redact`); marks inside a
 * whole-message redaction are simply removed. An unpaired or empty `||` stays
 * literal, so `a || b` in ordinary conversation is not a redaction.
 *
 * publicText and plain are ALIGNED BY CODE POINT — every hidden code point is
 * replaced by exactly one glyph and every visible one kept. RedactedText relies
 * on it to lift a bar over the right characters of the plaintext.
 */
export function parseRedaction(raw: string, whole = false): Redaction {
  const hidden: boolean[] = [];
  let plain = "";
  let platformText = "";
  let last = 0;
  for (const m of raw.matchAll(/\|\|([\s\S]+?)\|\|/g)) {
    const inner = m[1]!;
    if (!inner.trim()) continue;
    const before = raw.slice(last, m.index);
    plain += before + inner;
    platformText += before + REDACTED_LABEL;
    hidden.push(...Array.from(before, () => false), ...Array.from(inner, () => true));
    last = m.index! + m[0].length;
  }
  const tail = raw.slice(last);
  plain += tail;
  platformText += tail;
  hidden.push(...Array.from(tail, () => false));

  if (whole) {
    const has = plain.trim() !== "";
    return { plain, publicText: scramble(plain), platformText: has ? REDACTED_LABEL : plain, redacted: has };
  }
  const redacted = hidden.some(Boolean);
  if (!redacted) return { plain: raw, publicText: raw, platformText: raw, redacted: false };
  const cps = [...plain];
  const publicText = cps.map((ch, i) => (hidden[i] && !/\s/.test(ch) ? SHAPE_GLYPH[shapeOf(ch)] : ch)).join("");
  return { plain, publicText, platformText, redacted };
}

/** Is this one of the placeholder glyphs a hidden part is stored as? */
function isRedactGlyph(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return cp >= GLYPH_LO && cp <= GLYPH_HI;
}

export type RedactRun = {
  /** This run's text in the stored (public) message. */
  text: string;
  /** A hidden part — drawn as bars until a Supporter opens it. */
  hidden: boolean;
  /** Offset of the run, in CODE POINTS, into the message. */
  start: number;
};

/**
 * Find the hidden parts of a stored message again: a run of placeholder glyphs,
 * with the spaces BETWEEN hidden words counted as part of it. A message sealed
 * whole (and every one sent before partial redaction existed) is a single run.
 *
 * Derived from the glyphs rather than a stored span list, so no column or wire
 * field was added. The cost is that a Supporter could type block glyphs into the
 * visible part and get a bar that opens to the same glyphs — harmless.
 */
export function splitRedacted(text: string): RedactRun[] {
  const cps = [...text];
  const glyph = cps.map(isRedactGlyph);
  const nextNonSpace = (i: number, step: 1 | -1) => {
    for (let j = i + step; j >= 0 && j < cps.length; j += step) if (!/\s/.test(cps[j]!)) return j;
    return -1;
  };
  const hidden = cps.map((ch, i) => {
    if (glyph[i]) return true;
    if (!/\s/.test(ch)) return false;
    const a = nextNonSpace(i, -1), b = nextNonSpace(i, 1);
    return a !== -1 && b !== -1 && glyph[a]! && glyph[b]!;
  });
  const runs: RedactRun[] = [];
  cps.forEach((ch, i) => {
    const last = runs[runs.length - 1];
    if (last && last.hidden === hidden[i]) last.text += ch;
    else runs.push({ text: ch, hidden: hidden[i]!, start: i });
  });
  return runs;
}

/** Minimum social credit to send one. Threshold only — there is no spend. */
export const REDACT_MIN_CREDIT = 1;

/** How long a decrypted message stays readable before it re-scrambles. */
export const REDACT_REVEAL_MS = 10_000;

/** The chat's words for an open that was refused, by the server's status — one spelling for
 *  the chat row (RedactedText) and the terminal's chat TUI. Branches on the STATUS, never the
 *  server's message text: a wording choice would silently stop matching. */
export function revealRefusal(status: number): string {
  return status === 403 ? "Supporters can read this one."
    : status === 429 ? "Slow down a moment."
    : status === 404 ? "That message is gone."
    : status === 401 ? "Sign in to read this."
    : "Couldn't open it — try again.";
}

/** How long the character-by-character reveal (and the re-seal) takes. */
export const REDACT_ANIMATE_MS = 700;

/**
 * The redacted look: split a message into runs, where every non-space
 * character at index >= `shownUpTo` is covered by a bar. Whitespace is never
 * barred, so each WORD becomes one bar with the message's real word gaps
 * between them (split by word reads better than one bar per phrase).
 *
 * Still, not animated: a sealed message is `shownUpTo = 0` and never changes.
 * An idle shimmer re-rendering every sealed message on a 140 ms timer costs
 * too much — its on-screen fence does not hold, and on a desktop it kept a
 * browser at ~35% of a high-end GPU and cost a stream 1.1% of its frames to
 * encoding lag. The reveal walks `shownUpTo` from 0 up to the length, and the
 * re-seal back down.
 *
 * The characters under a bar are still rendered (transparent), so a bar is as
 * wide as the filler it covers — the shape filler (redactFiller) makes that
 * close to the hidden word, and RedactedText spaces the opened word to fill it
 * exactly, so nothing moves when a part opens.
 */
export function redactSegments(text: string, shownUpTo: number): { text: string; bar: boolean }[] {
  const out: { text: string; bar: boolean }[] = [];
  [...text].forEach((ch, i) => {
    const bar = !/\s/.test(ch) && i >= shownUpTo;
    const last = out[out.length - 1];
    if (last && last.bar === bar) last.text += ch;
    else out.push({ text: ch, bar });
  });
  return out;
}
