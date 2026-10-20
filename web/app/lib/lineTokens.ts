// Splitting a chat line into tokens.
//
// This is `text.split(" ")` with exactly one exception: a markdown link stays
// ONE token even though its label may contain spaces, so labels accept
// `[two words or more](url)`.
//
// THE TOKENIZER IS WHERE THIS LIVES, NOT THE REGEX. renderText's `MD_LINK_RE`
// has a `[^\]]+` label group, which matches spaces perfectly well — but a line
// split on spaces first never hands it a token containing one, and the pattern
// is anchored at both ends. Loosening the regex would change nothing.
//
// Lives here rather than in renderText.tsx so it can be unit-tested:
// `node --test` cannot load a .tsx file, which is the same reason the
// link-label guard is in ./linkGuard. This one runs on EVERY chat message.

/** The same shape, anchored only at the START, for scanning mid-line. */
const MD_LINK_HEAD_RE = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;

/**
 * `text.split(" ")`, except a markdown link stays ONE token even though it
 * contains spaces.
 *
 * The label group of `MD_LINK_RE` (`[^\]]+`) matches spaces, but only if the
 * token it is handed contains them — the line is split here, before the
 * anchored pattern runs, so this is where multi-word labels are made possible.
 *
 * A link is only kept whole when it is SPACE-DELIMITED — preceded by the start
 * of the line or a space, and followed by a space or the end. That is exactly
 * the boundary the anchored regex enforces, and keeping it preserves the
 * invariant the rest of the tokenizer depends on: consecutive tokens are always
 * separated by exactly one space, which is what `leading` encodes. Emitting a
 * link token that butts against adjacent text (`foo[a b](url)`) would make
 * `leading` insert a space that was never typed.
 */
export function splitTokens(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= text.length) {
    if (text[i] === "[") {
      const m = MD_LINK_HEAD_RE.exec(text.slice(i));
      if (m) {
        const end = i + m[0].length;
        if (end === text.length || text[end] === " ") {
          out.push(m[0]);
          i = end + 1;
          continue;
        }
      }
    }
    const sp = text.indexOf(" ", i);
    if (sp === -1) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, sp));
    i = sp + 1;
  }
  return out;
}

