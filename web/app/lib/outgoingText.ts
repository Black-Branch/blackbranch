// What a message must look like before it leaves the site for someone else's
// chat. Two different problems, deliberately solved two different ways.
//
// ── 1. Commands must not be relayed at all ──────────────────────────────────
// `!karma`, `!rank`, `!he/she/they` are addressed to OUR bot; `/me`, `/ban`,
// `/timeout` are addressed to the destination platform. Relaying either is
// wrong in a way the sender cannot see: a `!` command fires every other bot
// watching that channel, and a `/` command asks Twitch/Kick to *act* rather
// than to post. Neither is text a viewer was meant to read.
//
// ── 2. Twitch eats a leading `.` even when it is not a command ──────────────
// Twitch's Helix "Send Chat Message" parses a leading `.` as the legacy
// alias for `/` and posts only the remainder: `.6% - .7% between them awaree`
// is stored on Twitch as `- .7% between them awaree`, and `.6%-.7%` — one
// token, nothing left after the command word — never arrives at all. Open
// Twitch bug: https://github.com/twitchdev/issues/issues/1019
//
// That one ALSO produces a visible duplicate on the site: echo-dedup keys on
// message text, and the text Twitch echoes back no longer matches what we
// armed, so the mangled copy renders as a second message.
//
// `.` is ordinary text — decimals, ellipses — so suppressing it the way we
// suppress commands would lose real messages. It gets escaped instead.

// The invisible prefix that stops Twitch reading a message as a command.
// Deliberately NOT exported: the only thing worth asserting about it is what
// escapeLeadingCommand does with it, and a second importer would be a second
// place to change it.
const CMD_ESCAPE = "\u{E0000}";

/**
 * True when the destination platform would read this as a COMMAND rather than
 * as a message, and we should keep it on the site.
 *
 * Deliberately NOT `.` — see the header. A leading dot is real text and is
 * handled by {@link escapeLeadingCommand}.
 */
export function isPlatformCommand(text: string): boolean {
  return /^[!/]/.test(text.trimStart());
}

/**
 * Prefix an invisible character so a leading `.` or `/` survives Twitch's
 * command parser. No-op for anything else, so ordinary messages are untouched.
 *
 * **The escape itself is unverified against live Twitch** (verifying costs a
 * real post to a real channel). U+E0000 is a
 * Unicode TAG character: default-ignorable, so conforming clients render
 * nothing, and it is the character third-party Twitch clients already use to
 * defeat duplicate-message detection. The three outcomes:
 *   - Twitch stops command-parsing  → fixed.
 *   - Twitch strips it, then parses → the unescaped behaviour, no worse.
 *   - Twitch rejects the message    → worse. The one to watch for.
 * If mangled messages persist, that third case is what to check first.
 *
 * `stream-api/chat-dedup.js` strips U+E0000–U+E007F from the dedup key on
 * BOTH the arm and echo sides. Without that the escaped echo would come back
 * unmatched and render as a duplicate — which is half of what this fixes.
 */
export function escapeLeadingCommand(text: string): string {
  return /^[./]/.test(text) ? CMD_ESCAPE + text : text;
}
