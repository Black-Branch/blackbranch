// The chat font-size CSS expression, in ONE place.
//
// `--chat-font-size` is the user's chat text size (settings → Chat). It is always
// set at :root, so the `0.875rem` fallback below is inert in practice — it only
// guards rendering outside that scope. Hand-inlined across many components,
// changing the fallback (or spotting a typo'd one) would mean a grep-and-pray
// across the tree. This centralizes the token and the calc() wrapper so every
// consumer emits an identical string from one source.
//
// NOT importable from globals.css (the `--text-chat-*` named scale) or the
// layout.tsx prepaint <script> (a raw string that runs pre-hydration); those two
// keep their own copy of the literal by necessity. Everything in TS/TSX uses this.

/** `var(--chat-font-size, <default>)` — the raw chat size with its inert fallback. */
export const CHAT_FONT = "var(--chat-font-size, 0.875rem)";

/**
 * The named chat scale's metadata step (`--text-chat-xs`, globals.css) —
 * timestamps, bylines, "Now playing"-style chips. Several components still
 * inline the var() string; new code should import this instead so the scale
 * stays greppable from one place.
 */
export const CHAT_FONT_XS = "var(--text-chat-xs)";

/**
 * The named chat scale's small step (`--text-chat-sm`, globals.css) — composer
 * status lines that must actually be READ, not merely noticed: send errors,
 * command rejections, the slow-mode countdown.
 *
 * Not Tailwind's `text-xs`: a fixed 12px beside a chat column the user has set
 * to 21.6px reads at 0.555 of the chat. A status line about the chat belongs on
 * the chat axis, so it tracks the size the reader chose instead of being
 * frozen at the shell default.
 */
export const CHAT_FONT_SM = "var(--text-chat-sm)";

/**
 * `calc(CHAT_FONT * <expr>)`. `expr` may itself reference CSS vars, e.g.
 * `chatFontCalc("var(--chat-pfp-scale, 1)")` or `chatFontCalc(2.6)`.
 */
export const chatFontCalc = (expr: string | number): string => `calc(${CHAT_FONT} * ${expr})`;

/**
 * `var(<name>, CHAT_FONT)` — a chat-derived variable that falls back to the base
 * chat size (the timestamp / input sizes do this so an unset override inherits).
 */
export const chatFontVar = (name: string): string => `var(${name}, ${CHAT_FONT})`;

/**
 * The frozen avatar/badge basis (`--chat-row-basis`, globals.css). Avatars and
 * badges do not ride `--chat-font-size` (the Text Size slider scales the
 * message text, not the whole row) — they size against this constant and
 * answer only to their own × sliders. The fallback restates the globals.css
 * value the same way CHAT_FONT restates its default: inert while :root is in
 * scope, load-bearing only outside it.
 *
 * @test-only every call site composes this via rowBasisCalc below; the export
 * exists for chatFont.test.ts, which pins the fallback against the actual
 * --chat-row-basis declaration in globals.css (two restatements of one number).
 */
export const CHAT_ROW_BASIS = "var(--chat-row-basis, 1.352rem)";

/** `calc(CHAT_ROW_BASIS * <expr>)` — same shape as chatFontCalc, frozen basis. */
export const rowBasisCalc = (expr: string | number): string => `calc(${CHAT_ROW_BASIS} * ${expr})`;
