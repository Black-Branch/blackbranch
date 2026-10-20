// Unicode bidi-control neutralization for displayed identity text.
//
// WHY. Unicode has explicit bidirectional formatting controls that override how
// the characters AFTER them are laid out. An unterminated one does not stop at
// the end of the string it was typed into — it bleeds into whatever renders next
// in the same bidi paragraph. A username ending in U+202E (RIGHT-TO-LEFT
// OVERRIDE) can therefore reverse the display of the message beside it, and a
// link label containing one can make `moc.elpmaxe` read as `example.com`.
//
// This is live data, not theory: chat names ending in a single trailing U+202E
// occur in real chat logs. As a joke on your own name it is harmless — the same
// trick aimed at someone else's name, or at a link label, is a spoof. Related
// to the phishing annotation in renderText.tsx: both exist because the renderer
// would otherwise trust text to read the way it is stored.
//
// WHAT WE STRIP, AND WHY NOT MORE. Only the EXPLICIT controls:
//   U+202A LRE · U+202B RLE · U+202C PDF · U+202D LRO · U+202E RLO
//   U+2066 LRI · U+2067 RLI · U+2068 FSI · U+2069 PDI
// Genuine right-to-left text (Arabic, Hebrew, …) does NOT need these — the
// characters carry their own bidi class and lay out correctly without help. So
// stripping the overrides does not damage legitimate RTL names; it only removes
// the ability to reach outside your own span. The name stays; the superpower
// goes.
//
// SCOPE. Applied to displayed IDENTITY (usernames, Matrix display names) and to
// LINK LABELS. Deliberately NOT applied to message bodies: a user reversing
// their own message is a self-contained prank, each message renders in its own
// block, and silently rewriting what someone typed is a bigger behavioural
// change than this warrants. Revisit if a bleed across rows is ever observed.

// Written as \u escapes on purpose: these are invisible characters, so a literal
// class in source is unreadable, survives a copy/paste badly, and is impossible
// to review. Two separate regexes because a /g/ regex is STATEFUL — sharing one
// between .test() and .replace() carries lastIndex between calls and makes every
// other test return the wrong answer.
const BIDI_CLASS = "\\u202A-\\u202E\\u2066-\\u2069";
const BIDI_TEST = new RegExp(`[${BIDI_CLASS}]`);
const BIDI_ALL = new RegExp(`[${BIDI_CLASS}]`, "g");

/**
 * Remove explicit bidi controls from text that will be DISPLAYED as identity.
 * Returns the input unchanged when there is nothing to strip (the common case).
 */
export function stripBidiControls(s: string): string {
  return BIDI_TEST.test(s) ? s.replace(BIDI_ALL, "") : s;
}

/** True when the string carries an explicit bidi control (for tests/diagnostics). */
// @test-only bidi.test.ts asserts detection separately from stripping.
export function hasBidiControls(s: string): boolean {
  return BIDI_TEST.test(s);
}
