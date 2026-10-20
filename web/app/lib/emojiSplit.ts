// Split message text into plain-text and unicode-emoji runs. Pure (no React) so it
// can be unit-tested with `node --test` (native TS type-stripping) — the JSX that
// promotes emoji runs to <Twemoji> images lives in renderText.tsx.
//
// Unicode emoji in message text render as raw glyphs off the OS colour-emoji font
// — which is a plain "box" on clients without one (bare Arch, some Linux). Wrapping
// them in Twemoji (like Discord/Element) makes them look identical everywhere.

// Matches an emoji SEQUENCE: flag pairs, keycaps, or a pictographic base with an
// optional presentation selector / skin tone and any ZWJ-joined continuation.
// (`u` flag + property escapes — supported across the app's browser targets.)
// FE0F = emoji variation selector, 20E3 = combining enclosing keycap, 200D = ZWJ.
const EMOJI_RE =
  /(\p{RI}\p{RI}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F\u20E3?|[\u{1F3FB}-\u{1F3FF}])?(?:\u200D(?:\p{Extended_Pictographic}|\p{RI}\p{RI})(?:\p{Emoji_Modifier}|\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)*)/gu;
// Cheap pre-scan so pure-ASCII text (the overwhelming common case) skips the regex
// entirely. Covers the emoji ranges EMOJI_RE cares about; a false positive (e.g.
// kana) just runs the full regex, which then matches nothing.
const EMOJI_SCAN =
  /[\u203C-\u3299\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u20E3]/u;

// Bare text-presentation symbols that ARE Extended_Pictographic but are normally
// typed as text and render fine everywhere — keep a lone ™/©/® as text
// rather than a colour image. (Only when bare; a VS16 makes a longer match → emoji.)
const TEXT_SYMBOLS = new Set(["©", "®", "™"]);

export type EmojiPiece = { emoji: boolean; value: string };

// Split a text run into alternating plain-text and single-emoji pieces. Adjacent
// text is coalesced so a run of symbols/text stays one segment.
export function splitEmoji(text: string): EmojiPiece[] {
  if (!EMOJI_SCAN.test(text)) return [{ emoji: false, value: text }];
  const out: EmojiPiece[] = [];
  const pushText = (v: string) => {
    const last = out[out.length - 1];
    if (last && !last.emoji) last.value += v;
    else out.push({ emoji: false, value: v });
  };
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) pushText(text.slice(last, idx));
    if (TEXT_SYMBOLS.has(m[0])) pushText(m[0]);
    else out.push({ emoji: true, value: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}
